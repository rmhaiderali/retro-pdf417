/*
 * Converts PDF417 codewords (data followed by error correction) into a bit
 * matrix, one entry per symbol row, where 1 is a dark module and 0 is light.
 *
 * Layout of every symbol row, left to right
 *   start pattern            17 modules
 *   left row indicator       17 modules
 *   data codewords           17 modules each, columnCount of them
 *   right row indicator      17 modules
 *   stop pattern             18 modules
 * Matrix width is therefore 69 + 17 * columnCount modules.
 *
 * Codewords fill the rows from left to right, top to bottom. Each row uses
 * one of three bar patterns per codeword value (its cluster), chosen by
 * rowIndex % 3, so neighbouring rows never look alike and a scanner can tell
 * which row it is reading from the pattern alone.
 *
 * The row indicators carry the symbol parameters so a scanner can recover
 * them from any single row. Each indicator is 30 * floor(rowIndex / 3) plus
 * one of three values, depending on the cluster:
 *   cluster 0   left: floor((rows - 1) / 3)            right: columns - 1
 *   cluster 1   left: errorLevel * 3 + (rows - 1) % 3  right: floor((rows - 1) / 3)
 *   cluster 2   left: columns - 1                      right: errorLevel * 3 + (rows - 1) % 3
 *
 * Scaling follows the usual PDF417 writer convention: every module becomes
 * "scale" columns wide and every symbol row is repeated
 * rowRepeat * scale times, because rows must be taller than a module to scan
 * reliably. With the defaults (scale 1, rowRepeat 3) the symbol is
 * (69 + 17 * columnCount) wide and 3 * rowCount tall, plus the quiet zone.
 *
 * The quiet zone is "margin" modules (default 4) of light modules on every
 * side, scaled by "scale" like the symbol itself, so the returned matrix is
 * ready to render as is.
 */
import { CODEWORD_PATTERNS } from "./codeword-patterns.js"

const START_PATTERN = 0x1fea8
const START_PATTERN_LENGTH = 17
const STOP_PATTERN = 0x3fa29
const STOP_PATTERN_LENGTH = 18
const CODEWORD_PATTERN_LENGTH = 17
const CLUSTER_COUNT = 3

const MIN_COLUMNS = 1
const MAX_COLUMNS = 30
const MIN_ROWS = 3
const MAX_ROWS = 90
const MAX_ERROR_CORRECTION_LEVEL = 8
const CODEWORD_VALUE_COUNT = 929

function appendPattern(rowModules, pattern, patternLength) {
  for (let bit = patternLength - 1; bit >= 0; bit--) {
    rowModules.push((pattern >> bit) & 1)
  }
}

function computeRowIndicators(rowIndex, rowCount, columnCount, ecLevel) {
  const cluster = rowIndex % CLUSTER_COUNT
  const base = Math.floor(rowIndex / CLUSTER_COUNT) * 30
  const rowCountPart = Math.floor((rowCount - 1) / 3)
  const levelAndRowPart = ecLevel * 3 + ((rowCount - 1) % 3)
  const columnPart = columnCount - 1

  if (cluster === 0) return [base + rowCountPart, base + columnPart]
  if (cluster === 1) return [base + levelAndRowPart, base + rowCountPart]
  return [base + columnPart, base + levelAndRowPart]
}

function validateSymbolParameters(codewords, columnCount, ecLevel) {
  if (columnCount < MIN_COLUMNS || columnCount > MAX_COLUMNS) {
    throw new Error("Column count must be " + MIN_COLUMNS + ".." + MAX_COLUMNS)
  }

  const cwLength = codewords.length

  if (cwLength % columnCount !== 0) {
    throw new Error(
      cwLength + " codewords do not fill " + columnCount + " columns evenly",
    )
  }
  const rowCount = codewords.length / columnCount
  if (rowCount < MIN_ROWS || rowCount > MAX_ROWS) {
    throw new Error(
      "Row count must be " + MIN_ROWS + ".." + MAX_ROWS + ", got " + rowCount,
    )
  }
  if (ecLevel < 0 || ecLevel > MAX_ERROR_CORRECTION_LEVEL) {
    throw new Error(
      "Error correction level must be 0.." + MAX_ERROR_CORRECTION_LEVEL,
    )
  }
  for (const codeword of codewords) {
    if (
      !Number.isInteger(codeword) ||
      codeword < 0 ||
      codeword >= CODEWORD_VALUE_COUNT
    ) {
      throw new Error("Invalid codeword " + codeword)
    }
  }
}

function scaleRow(rowModules, scale) {
  if (scale === 1) return rowModules
  const scaledRow = new Uint8Array(rowModules.length * scale)
  for (let module = 0; module < rowModules.length; module++) {
    scaledRow.fill(rowModules[module], module * scale, (module + 1) * scale)
  }
  return scaledRow
}

function generateBitMatrix(codewords, columnCount, options = {}) {
  const { scale = 1, margin = 4, rowRepeat = 3 } = options
  const ecLevel = 4

  validateSymbolParameters(codewords, columnCount, ecLevel)

  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error("options.scale must be a non-zero positive integer")
  }

  if (!Number.isInteger(margin) || margin < 0) {
    throw new Error("options.margin must be a non-negative integer")
  }

  if (!Number.isInteger(rowRepeat) || rowRepeat < 1) {
    throw new Error("options.rowRepeat must be a non-zero positive integer")
  }

  const rowCount = codewords.length / columnCount

  const scaledRowRepeat = rowRepeat * scale
  const scaledMargin = margin * scale

  const symbolWidth = (69 + 17 * columnCount) * scale
  const paddedWidth = symbolWidth + scaledMargin * 2
  const bitMatrix = []

  for (let rowIndex = 0; rowIndex < scaledMargin; rowIndex++) {
    bitMatrix.push(new Uint8Array(paddedWidth))
  }

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const patterns = CODEWORD_PATTERNS[rowIndex % CLUSTER_COUNT]
    const [leftIndicator, rightIndicator] = computeRowIndicators(
      rowIndex,
      rowCount,
      columnCount,
      ecLevel,
    )
    const rowModules = []

    appendPattern(rowModules, START_PATTERN, START_PATTERN_LENGTH)
    appendPattern(rowModules, patterns[leftIndicator], CODEWORD_PATTERN_LENGTH)
    for (let column = 0; column < columnCount; column++) {
      const codeword = codewords[rowIndex * columnCount + column]
      appendPattern(rowModules, patterns[codeword], CODEWORD_PATTERN_LENGTH)
    }
    appendPattern(rowModules, patterns[rightIndicator], CODEWORD_PATTERN_LENGTH)
    appendPattern(rowModules, STOP_PATTERN, STOP_PATTERN_LENGTH)

    const scaledRow = scaleRow(Uint8Array.from(rowModules), scale)
    const paddedRow = new Uint8Array(paddedWidth)
    paddedRow.set(scaledRow, scaledMargin)
    for (let repeat = 0; repeat < scaledRowRepeat; repeat++) {
      bitMatrix.push(paddedRow.slice())
    }
  }

  for (let rowIndex = 0; rowIndex < scaledMargin; rowIndex++) {
    bitMatrix.push(new Uint8Array(paddedWidth))
  }

  return bitMatrix
}

export { generateBitMatrix }
