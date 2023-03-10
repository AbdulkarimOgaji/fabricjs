// import GIF from 'js-binary-schema-parser/lib/schemas/gif'
// import { parse } from 'js-binary-schema-parser'
// import { buildStream } from 'js-binary-schema-parser/lib/parsers/uint8'
// import { deinterlace } from './deinterlace'
// import { lzw } from './lzw'

const buildStream = (uint8Data) => ({
  data: uint8Data,
  pos: 0,
});

const readByte = () => (stream) => {
  return stream.data[stream.pos++];
};

const peekByte =
  (offset = 0) =>
  (stream) => {
    return stream.data[stream.pos + offset];
  };

const readBytes = (length) => (stream) => {
  return stream.data.subarray(stream.pos, (stream.pos += length));
};

const peekBytes = (length) => (stream) => {
  return stream.data.subarray(stream.pos, stream.pos + length);
};

const readString = (length) => (stream) => {
  return Array.from(readBytes(length)(stream))
    .map((value) => String.fromCharCode(value))
    .join("");
};

const readUnsigned = (littleEndian) => (stream) => {
  const bytes = readBytes(2)(stream);
  return littleEndian ? (bytes[1] << 8) + bytes[0] : (bytes[0] << 8) + bytes[1];
};

const readArray = (byteSize, totalOrFunc) => (stream, result, parent) => {
  const total =
    typeof totalOrFunc === "function"
      ? totalOrFunc(stream, result, parent)
      : totalOrFunc;

  const parser = readBytes(byteSize);
  const arr = new Array(total);
  for (var i = 0; i < total; i++) {
    arr[i] = parser(stream);
  }
  return arr;
};

const subBitsTotal = (bits, startIndex, length) => {
  var result = 0;
  for (var i = 0; i < length; i++) {
    result += bits[startIndex + i] && 2 ** (length - i - 1);
  }
  return result;
};

const readBits = (schema) => (stream) => {
  const byte = readByte()(stream);
  // convert the byte to bit array
  const bits = new Array(8);
  for (var i = 0; i < 8; i++) {
    bits[7 - i] = !!(byte & (1 << i));
  }
  // convert the bit array to values based on the schema
  return Object.keys(schema).reduce((res, key) => {
    const def = schema[key];
    if (def.length) {
      res[key] = subBitsTotal(bits, def.index, def.length);
    } else {
      res[key] = bits[def.index];
    }
    return res;
  }, {});
};
parse = (stream, schema, result = {}, parent = result) => {
  if (Array.isArray(schema)) {
    schema.forEach((partSchema) => parse(stream, partSchema, result, parent));
  } else if (typeof schema === "function") {
    schema(stream, result, parent, parse);
  } else {
    const key = Object.keys(schema)[0];
    if (Array.isArray(schema[key])) {
      parent[key] = {};
      parse(stream, schema[key], result, parent[key]);
    } else {
      parent[key] = schema[key](stream, result, parent, parse);
    }
  }
  return result;
};

const conditional =
  (schema, conditionFunc) => (stream, result, parent, parse) => {
    if (conditionFunc(stream, result, parent)) {
      parse(stream, schema, result, parent);
    }
  };

const loop = (schema, continueFunc) => (stream, result, parent, parse) => {
  const arr = [];
  let lastStreamPos = stream.pos;
  while (continueFunc(stream, result, parent)) {
    const newParent = {};
    parse(stream, schema, result, newParent);
    // cases when whole file is parsed but no termination is there and stream position is not getting updated as well
    // it falls into infinite recursion, null check to avoid the same
    if (stream.pos === lastStreamPos) {
      break;
    }
    lastStreamPos = stream.pos;
    arr.push(newParent);
  }
  return arr;
};

/** **
 *
 *
 *
 *
 *
 *
 * ***/

var subBlocksSchema = {
  blocks: (stream) => {
    const terminator = 0x00;
    const chunks = [];
    const streamSize = stream.data.length;
    var total = 0;
    for (
      var size = readByte()(stream);
      size !== terminator;
      size = readByte()(stream)
    ) {
      // size becomes undefined for some case when file is corrupted and  terminator is not proper
      // null check to avoid recursion
      if (!size) break;
      // catch corrupted files with no terminator
      if (stream.pos + size >= streamSize) {
        const availableSize = streamSize - stream.pos;
        chunks.push(readBytes(availableSize)(stream));
        total += availableSize;
        break;
      }
      chunks.push(readBytes(size)(stream));
      total += size;
    }
    const result = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      result.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return result;
  },
};

// global control extension
const gceSchema = conditional(
  {
    gce: [
      { codes: readBytes(2) },
      { byteSize: readByte() },
      {
        extras: readBits({
          future: { index: 0, length: 3 },
          disposal: { index: 3, length: 3 },
          userInput: { index: 6 },
          transparentColorGiven: { index: 7 },
        }),
      },
      { delay: readUnsigned(true) },
      { transparentColorIndex: readByte() },
      { terminator: readByte() },
    ],
  },
  (stream) => {
    var codes = peekBytes(2)(stream);
    return codes[0] === 0x21 && codes[1] === 0xf9;
  }
);

// image pipeline block
const imageSchema = conditional(
  {
    image: [
      { code: readByte() },
      {
        descriptor: [
          { left: readUnsigned(true) },
          { top: readUnsigned(true) },
          { width: readUnsigned(true) },
          { height: readUnsigned(true) },
          {
            lct: readBits({
              exists: { index: 0 },
              interlaced: { index: 1 },
              sort: { index: 2 },
              future: { index: 3, length: 2 },
              size: { index: 5, length: 3 },
            }),
          },
        ],
      },
      conditional(
        {
          lct: readArray(3, (stream, result, parent) => {
            return Math.pow(2, parent.descriptor.lct.size + 1);
          }),
        },
        (stream, result, parent) => {
          return parent.descriptor.lct.exists;
        }
      ),
      { data: [{ minCodeSize: readByte() }, subBlocksSchema] },
    ],
  },
  (stream) => {
    return peekByte()(stream) === 0x2c;
  }
);

// plain text block
const textSchema = conditional(
  {
    text: [
      { codes: readBytes(2) },
      { blockSize: readByte() },
      {
        preData: (stream, result, parent) =>
          readBytes(parent.text.blockSize)(stream),
      },
      subBlocksSchema,
    ],
  },
  (stream) => {
    var codes = peekBytes(2)(stream);
    return codes[0] === 0x21 && codes[1] === 0x01;
  }
);

// application block
const applicationSchema = conditional(
  {
    application: [
      { codes: readBytes(2) },
      { blockSize: readByte() },
      { id: (stream, result, parent) => readString(parent.blockSize)(stream) },
      subBlocksSchema,
    ],
  },
  (stream) => {
    var codes = peekBytes(2)(stream);
    return codes[0] === 0x21 && codes[1] === 0xff;
  }
);

// comment block
const commentSchema = conditional(
  {
    comment: [{ codes: readBytes(2) }, subBlocksSchema],
  },
  (stream) => {
    var codes = peekBytes(2)(stream);
    return codes[0] === 0x21 && codes[1] === 0xfe;
  }
);

const schema = [
  { header: [{ signature: readString(3) }, { version: readString(3) }] },
  {
    lsd: [
      { width: readUnsigned(true) },
      { height: readUnsigned(true) },
      {
        gct: readBits({
          exists: { index: 0 },
          resolution: { index: 1, length: 3 },
          sort: { index: 4 },
          size: { index: 5, length: 3 },
        }),
      },
      { backgroundColorIndex: readByte() },
      { pixelAspectRatio: readByte() },
    ],
  },
  conditional(
    {
      gct: readArray(3, (stream, result) =>
        Math.pow(2, result.lsd.gct.size + 1)
      ),
    },
    (stream, result) => result.lsd.gct.exists
  ),
  // content frames
  {
    frames: loop(
      [gceSchema, applicationSchema, commentSchema, imageSchema, textSchema],
      (stream) => {
        var nextCode = peekByte()(stream);
        // rather than check for a terminator, we should check for the existence
        // of an ext or image block to avoid infinite loops
        //var terminator = 0x3B;
        //return nextCode !== terminator;
        return nextCode === 0x21 || nextCode === 0x2c;
      }
    ),
  },
];
/**
 *
 *
 */

const lzw = (minCodeSize, data, pixelCount) => {
  const MAX_STACK_SIZE = 4096;
  const nullCode = -1;
  const npix = pixelCount;
  var available,
    clear,
    code_mask,
    code_size,
    end_of_information,
    in_code,
    old_code,
    bits,
    code,
    i,
    datum,
    data_size,
    first,
    top,
    bi,
    pi;

  const dstPixels = new Array(pixelCount);
  const prefix = new Array(MAX_STACK_SIZE);
  const suffix = new Array(MAX_STACK_SIZE);
  const pixelStack = new Array(MAX_STACK_SIZE + 1);

  // Initialize GIF data stream decoder.
  data_size = minCodeSize;
  clear = 1 << data_size;
  end_of_information = clear + 1;
  available = clear + 2;
  old_code = nullCode;
  code_size = data_size + 1;
  code_mask = (1 << code_size) - 1;
  for (code = 0; code < clear; code++) {
    prefix[code] = 0;
    suffix[code] = code;
  }

  // Decode GIF pixel stream.
  var datum, bits, count, first, top, pi, bi;
  datum = bits = count = first = top = pi = bi = 0;
  for (i = 0; i < npix; ) {
    if (top === 0) {
      if (bits < code_size) {
        // get the next byte
        datum += data[bi] << bits;

        bits += 8;
        bi++;
        continue;
      }
      // Get the next code.
      code = datum & code_mask;
      datum >>= code_size;
      bits -= code_size;
      // Interpret the code
      if (code > available || code == end_of_information) {
        break;
      }
      if (code == clear) {
        // Reset decoder.
        code_size = data_size + 1;
        code_mask = (1 << code_size) - 1;
        available = clear + 2;
        old_code = nullCode;
        continue;
      }
      if (old_code == nullCode) {
        pixelStack[top++] = suffix[code];
        old_code = code;
        first = code;
        continue;
      }
      in_code = code;
      if (code == available) {
        pixelStack[top++] = first;
        code = old_code;
      }
      while (code > clear) {
        pixelStack[top++] = suffix[code];
        code = prefix[code];
      }

      first = suffix[code] & 0xff;
      pixelStack[top++] = first;

      // add a new string to the table, but only if space is available
      // if not, just continue with current table until a clear code is found
      // (deferred clear code implementation as per GIF spec)
      if (available < MAX_STACK_SIZE) {
        prefix[available] = old_code;
        suffix[available] = first;
        available++;
        if ((available & code_mask) === 0 && available < MAX_STACK_SIZE) {
          code_size++;
          code_mask += available;
        }
      }
      old_code = in_code;
    }
    // Pop a pixel off the pixel stack.
    top--;
    dstPixels[pi++] = pixelStack[top];
    i++;
  }

  for (i = pi; i < npix; i++) {
    dstPixels[i] = 0; // clear missing pixels
  }

  return dstPixels;
};

const deinterlace = (pixels, width) => {
  const newPixels = new Array(pixels.length);
  const rows = pixels.length / width;
  const cpRow = function (toRow, fromRow) {
    const fromPixels = pixels.slice(fromRow * width, (fromRow + 1) * width);
    newPixels.splice.apply(
      newPixels,
      [toRow * width, width].concat(fromPixels)
    );
  };

  // See appendix E.
  const offsets = [0, 4, 2, 1];
  const steps = [8, 8, 4, 2];

  var fromRow = 0;
  for (var pass = 0; pass < 4; pass++) {
    for (var toRow = offsets[pass]; toRow < rows; toRow += steps[pass]) {
      cpRow(toRow, fromRow);
      fromRow++;
    }
  }

  return newPixels;
};

const parseGIF = (arrayBuffer) => {
  const byteData = new Uint8Array(arrayBuffer);
  const buildStreamData = buildStream(byteData);
  const parseBuildStreamData = parse(buildStreamData, schema);
  return parseBuildStreamData;
  // return parse(buildStream(byteData), GIF);
};

const generatePatch = (image) => {
  const totalPixels = image.pixels.length;
  const patchData = new Uint8ClampedArray(totalPixels * 4);
  for (var i = 0; i < totalPixels; i++) {
    const pos = i * 4;
    const colorIndex = image.pixels[i];
    const color = image.colorTable[colorIndex] || [0, 0, 0];
    patchData[pos] = color[0];
    patchData[pos + 1] = color[1];
    patchData[pos + 2] = color[2];
    patchData[pos + 3] = colorIndex !== image.transparentIndex ? 255 : 0;
  }

  return patchData;
};

const decompressFrame = (frame, gct, buildImagePatch) => {
  if (!frame.image) {
    console.warn("gif frame does not have associated image.");
    return;
  }

  const { image } = frame;

  // get the number of pixels
  const totalPixels = image.descriptor.width * image.descriptor.height;
  // do lzw decompression
  var pixels = lzw(image.data.minCodeSize, image.data.blocks, totalPixels);

  // deal with interlacing if necessary
  if (image.descriptor.lct.interlaced) {
    pixels = deinterlace(pixels, image.descriptor.width);
  }

  const resultImage = {
    pixels: pixels,
    dims: {
      top: frame.image.descriptor.top,
      left: frame.image.descriptor.left,
      width: frame.image.descriptor.width,
      height: frame.image.descriptor.height,
    },
  };

  // color table
  if (image.descriptor.lct && image.descriptor.lct.exists) {
    resultImage.colorTable = image.lct;
  } else {
    resultImage.colorTable = gct;
  }

  // add per frame relevant gce information
  if (frame.gce) {
    resultImage.delay = (frame.gce.delay || 10) * 10; // convert to ms
    resultImage.disposalType = frame.gce.extras.disposal;
    // transparency
    if (frame.gce.extras.transparentColorGiven) {
      resultImage.transparentIndex = frame.gce.transparentColorIndex;
    }
  }

  // create canvas usable imagedata if desired
  if (buildImagePatch) {
    resultImage.patch = generatePatch(resultImage);
  }

  return resultImage;
};

const decompressFrames = (parsedGif, buildImagePatches) => {
  return parsedGif.frames
    .filter((f) => f.image)
    .map((f) => decompressFrame(f, parsedGif.gct, buildImagePatches));
};
