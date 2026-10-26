import { deflate } from "pako"
import { encode, ColorType } from "png-tools"
import { generateBitMatrix } from "./generate-bitmatrix.js"
import { generateCodeWords } from "./generate-codewords.js"

function generateBarcode(bytes, options = {}) {
  const { scale = 1, margin = 4, verticalStretch = 0.5 } = options

  const isBytesUint8Array = bytes instanceof Uint8Array

  if (!isBytesUint8Array) {
    throw new Error("Input must be a Uint8Array")
  }

  const { codewords, columnCount } = generateCodeWords(bytes)

  if (columnCount > 30) {
    throw new Error("Too much bytes to encode")
  }

  const opts = { scale, margin, verticalStretch }
  const bitMatrix = generateBitMatrix(codewords, columnCount, opts)

  const width = bitMatrix[0].length
  const height = bitMatrix.length
  const pixels = new Uint8Array(width * height).fill(255)

  bitMatrix.forEach((row, y) => {
    row.forEach((module, x) => {
      if (module) pixels[y * width + x] = 0
    })
  })

  const image = {
    width,
    height,
    data: pixels,
    colorType: ColorType.GRAYSCALE,
  }

  return encode(image, deflate)
}

export { generateBarcode }
