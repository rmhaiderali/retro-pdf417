/*
 * PDF417 codeword encoder for fixed-size 400-byte records (space padded).
 *
 * Prints the segment list, then the full codeword sequence (data + error
 * correction) as 3-digit hex values.
 *
 * Pipeline
 *   1. segmentRecord splits the record into segments, each tagged with the
 *      compaction mode that will encode it:
 *        "N" numeric  - runs of at least numericMinRun digits (default 14).
 *                       Shorter digit runs are cheaper to leave as text.
 *        "T" text     - bytes 9, 10, 13 and 32..126.
 *        "B" byte     - everything else (raw binary, e.g. non-ASCII text).
 *      Refinements applied after the initial split:
 *        - A short text gap (under textMinRun bytes) sitting between two
 *          numeric runs becomes a byte segment and also takes the first digit
 *          of the following numeric run.
 *        - Any text run under textMinRun bytes that touches a byte segment is
 *          merged into it, because switching modes costs more codewords than
 *          it saves. Adjacent segments of the same mode are then merged.
 *        - A byte segment whose last byte is not 0x06 takes one extra byte
 *          from the start of the following text segment (only when that
 *          segment has more than one byte). The latch codeword is still
 *          chosen from the byte count before the extra byte was added, and
 *          that count is stored as a fourth element of the segment.
 *
 *   2. encodeSegments converts the segments to codewords:
 *        text    - sub-modes alpha / lower / mixed / punctuation, two text
 *                  values per codeword. Punctuation is always reached with a
 *                  single-character shift (29) and never by latching (25).
 *                  An odd final value is padded with 29.
 *        numeric - latch 902, then 44-digit groups converted to base 900.
 *        byte    - latch 924 when the byte count is a multiple of 6, else
 *                  901. Every 6 bytes become 5 base-900 codewords and the
 *                  remainder bytes are emitted as-is. A single byte following
 *                  text uses the 913 shift instead of a latch.
 *      A text segment that follows a numeric or byte segment is preceded by
 *      the text latch (900), except when it is the very first segment.
 *      The first codeword is the symbol length descriptor (total data
 *      codewords, including itself). The result is padded with 900 up to that
 *      length.
 *
 *   3. computeSymbolSize chooses the symbol layout. With 32 error correction
 *      codewords (security level 4), N = content length + 32,
 *      columns = ceil(N / 20), rows = ceil(N / columns), and the number of
 *      data codewords is columns * rows - 32.
 *
 *   4. computeErrorCorrection appends 32 Reed-Solomon check codewords over
 *      GF(929), using generator roots 3^1 .. 3^32.
 *
 * The thresholds and merge rules in step 1 were derived by matching encoder
 * output against real symbols. Digit runs of exactly 14 digits, text runs
 * between 6 and 34 bytes inside binary data, and other record lengths have
 * not been verified.
 */

import { Buffer } from "buffer"

const MIXED_SUBMODE_CHARS = "0123456789&\r\t,:#-.$/+%*=^"
const PUNCTUATION_CHARS = ";<>@[\\]_`~!\r\t,:\n-.$/\"|*()?{}'"

const MIXED_VALUE_BY_BYTE = new Map()
MIXED_SUBMODE_CHARS.split("").forEach((char, index) =>
  MIXED_VALUE_BY_BYTE.set(char.charCodeAt(0), index),
)
MIXED_VALUE_BY_BYTE.set(32, 26)

const PUNCTUATION_VALUE_BY_BYTE = new Map()
PUNCTUATION_CHARS.split("").forEach((char, index) =>
  PUNCTUATION_VALUE_BY_BYTE.set(char.charCodeAt(0), index),
)

const SUBMODE_ALPHA = 0
const SUBMODE_LOWER = 1
const SUBMODE_MIXED = 2

const isUpperCaseOrSpace = (byte) => byte === 32 || (byte >= 65 && byte <= 90)
const isLowerCaseOrSpace = (byte) => byte === 32 || (byte >= 97 && byte <= 122)
const isTextEligibleByte = (byte) =>
  byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)

function lookupPunctuationValue(byte) {
  if (!PUNCTUATION_VALUE_BY_BYTE.has(byte)) {
    throw new Error(`Byte ${byte} has no punctuation value`)
  }
  return PUNCTUATION_VALUE_BY_BYTE.get(byte)
}

function modularPower(base, exponent, modulus) {
  let result = 1
  let current = base % modulus
  let remaining = exponent
  while (remaining > 0) {
    if (remaining & 1) result = (result * current) % modulus
    current = (current * current) % modulus
    remaining >>= 1
  }
  return result
}

// JavaScript % operator keeps the sign of the dividend, but field arithmetic needs 0..modulus-1
function positiveModulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus
}

function encodeTextCompaction(bytes, startSubmode = SUBMODE_ALPHA) {
  let submode = startSubmode
  const textValues = []
  let index = 0

  while (true) {
    const currentByte = bytes[index]
    let advance = true

    if (submode === SUBMODE_ALPHA) {
      if (isUpperCaseOrSpace(currentByte)) {
        textValues.push(currentByte === 32 ? 26 : currentByte - 65)
      } else if (isLowerCaseOrSpace(currentByte)) {
        submode = SUBMODE_LOWER
        textValues.push(27)
        advance = false
      } else if (MIXED_VALUE_BY_BYTE.has(currentByte)) {
        submode = SUBMODE_MIXED
        textValues.push(28)
        advance = false
      } else {
        textValues.push(29)
        textValues.push(lookupPunctuationValue(currentByte))
      }
    } else if (submode === SUBMODE_LOWER) {
      if (isLowerCaseOrSpace(currentByte)) {
        textValues.push(currentByte === 32 ? 26 : currentByte - 97)
      } else if (isUpperCaseOrSpace(currentByte)) {
        textValues.push(27)
        textValues.push(currentByte - 65)
      } else if (MIXED_VALUE_BY_BYTE.has(currentByte)) {
        submode = SUBMODE_MIXED
        textValues.push(28)
        advance = false
      } else {
        textValues.push(29)
        textValues.push(lookupPunctuationValue(currentByte))
      }
    } else if (submode === SUBMODE_MIXED) {
      if (MIXED_VALUE_BY_BYTE.has(currentByte)) {
        textValues.push(MIXED_VALUE_BY_BYTE.get(currentByte))
      } else if (isUpperCaseOrSpace(currentByte)) {
        submode = SUBMODE_ALPHA
        textValues.push(28)
        advance = false
      } else if (isLowerCaseOrSpace(currentByte)) {
        submode = SUBMODE_LOWER
        textValues.push(27)
        advance = false
      } else {
        // Shift instead of latching to the punctuation sub-mode, which keeps
        // the encoder in mixed mode for the characters that follow
        textValues.push(29)
        textValues.push(lookupPunctuationValue(currentByte))
      }
    } else {
      if (PUNCTUATION_VALUE_BY_BYTE.has(currentByte)) {
        textValues.push(PUNCTUATION_VALUE_BY_BYTE.get(currentByte))
      } else {
        submode = SUBMODE_ALPHA
        textValues.push(29)
        advance = false
      }
    }

    if (advance) {
      index += 1
      if (index >= bytes.length) break
    }
  }

  const codewords = []
  let highValue = 0
  textValues.forEach((value, position) => {
    if (position % 2 === 0) {
      highValue = value
    } else {
      codewords.push(highValue * 30 + value)
    }
  })
  if (textValues.length % 2) codewords.push(highValue * 30 + 29)
  return codewords
}

function encodeNumericCompaction(digitString) {
  const codewords = []
  for (let start = 0; start < digitString.length; start += 44) {
    // The leading 1 preserves leading zeros through the base conversion
    let value = BigInt("1" + digitString.slice(start, start + 44))
    const groupCodewords = []
    while (value) {
      groupCodewords.push(Number(value % 900n))
      value /= 900n
    }
    codewords.push(...groupCodewords.reverse())
  }
  return codewords
}

function encodeByteCompaction(
  bytes,
  previousSegmentWasText,
  latchLength = null,
) {
  if (bytes.length === 1 && previousSegmentWasText) return [913, bytes[0]]
  if (latchLength === null) latchLength = bytes.length

  const codewords = [latchLength % 6 === 0 ? 924 : 901]
  const fullGroupsEnd = Math.floor(bytes.length / 6) * 6

  for (let start = 0; start < fullGroupsEnd; start += 6) {
    let value = 0n
    for (let offset = 0; offset < 6; offset++) {
      value = (value << 8n) | BigInt(bytes[start + offset])
    }
    const groupCodewords = []
    for (let i = 0; i < 5; i++) {
      groupCodewords.push(Number(value % 900n))
      value /= 900n
    }
    codewords.push(...groupCodewords.reverse())
  }
  for (let i = fullGroupsEnd; i < bytes.length; i++) codewords.push(bytes[i])
  return codewords
}

function encodeSegments(data, segments, totalCodewords = 288) {
  const codewords = []
  let currentMode = "T"
  let isFirstSegment = true

  for (const segment of segments) {
    const [kind, startIndex, endIndex] = segment
    const latchLength = segment.length > 3 ? segment[3] : null
    const segmentBytes = data.subarray(startIndex, endIndex)

    if (kind === "T") {
      if (!isFirstSegment && currentMode !== "T") codewords.push(900)
      codewords.push(...encodeTextCompaction(Array.from(segmentBytes)))
      currentMode = "T"
    } else if (kind === "N") {
      codewords.push(902)
      codewords.push(
        ...encodeNumericCompaction(
          Buffer.from(segmentBytes).toString("latin1"),
        ),
      )
      currentMode = "N"
    } else {
      codewords.push(
        ...encodeByteCompaction(segmentBytes, currentMode === "T", latchLength),
      )
      currentMode = "B"
    }
    isFirstSegment = false
  }

  let count = codewords.length + 1
  while (count < totalCodewords) {
    codewords.push(900)
    count += 1
  }
  return [totalCodewords, ...codewords]
}

function computeErrorCorrection(dataCodewords, eccCount = 32) {
  let generator = [1]
  for (let i = 1; i <= eccCount; i++) {
    const root = modularPower(3, i, 929)
    const next = new Array(generator.length + 1).fill(0)
    generator.forEach((coefficient, index) => {
      next[index + 1] = positiveModulo(next[index + 1] + coefficient, 929)
      next[index] = positiveModulo(next[index] - coefficient * root, 929)
    })
    generator = next
  }
  const factors = generator.slice(0, eccCount)

  const remainder = new Array(eccCount).fill(0)
  for (const dataCodeword of dataCodewords) {
    const feedback = (dataCodeword + remainder[eccCount - 1]) % 929
    for (let j = eccCount - 1; j > 0; j--) {
      remainder[j] =
        (remainder[j - 1] + 929 - ((feedback * factors[j]) % 929)) % 929
    }
    remainder[0] = (929 - ((feedback * factors[0]) % 929)) % 929
  }
  return remainder.reverse().map((x) => (x ? (929 - x) % 929 : 0))
}

function segmentRecord(record, numericMinRun = 14, textMinRun = 6) {
  const recordLength = record.length

  const recordAsLatin1 = Buffer.from(record).toString("latin1")
  const numericRuns = []
  for (const match of recordAsLatin1.matchAll(/\d+/g)) {
    const start = match.index
    const end = start + match[0].length
    if (end - start >= numericMinRun) numericRuns.push([start, end])
  }

  let position = 0
  const parts = []
  for (const [start, end] of numericRuns) {
    if (start > position) parts.push(["X", position, start])
    parts.push(["N", start, end])
    position = end
  }
  if (position < recordLength) parts.push(["X", position, recordLength])

  const segments = []
  for (const [kind, start, end] of parts) {
    if (kind === "N") {
      segments.push(["N", start, end])
      continue
    }
    let runStart = start
    for (let j = start; j <= end; j++) {
      if (
        j === end ||
        isTextEligibleByte(record[j]) !== isTextEligibleByte(record[runStart])
      ) {
        segments.push([
          isTextEligibleByte(record[runStart]) ? "T" : "B",
          runStart,
          j,
        ])
        runStart = j
      }
    }
  }

  // The record layout puts a separator byte plus the first digit of the next
  // number into a byte block, so the digit must leave the numeric run
  let index = 1
  while (index + 1 < segments.length) {
    if (
      segments[index - 1][0] === "N" &&
      segments[index][0] === "T" &&
      segments[index][2] - segments[index][1] < textMinRun &&
      segments[index + 1][0] === "N"
    ) {
      segments[index][0] = "B"
      segments[index][2] += 1
      segments[index + 1][1] += 1
    }
    index += 1
  }

  // Repeat until stable: absorbing one run can make a neighbour qualify
  let changed = true
  while (changed) {
    changed = false
    for (let k = 0; k < segments.length; k++) {
      const segment = segments[k]
      if (segment[0] === "T" && segment[2] - segment[1] < textMinRun) {
        const hasBinaryNeighbour =
          (k > 0 && segments[k - 1][0] === "B") ||
          (k + 1 < segments.length && segments[k + 1][0] === "B")
        if (hasBinaryNeighbour) {
          segment[0] = "B"
          changed = true
          break
        }
      }
    }
    let mergeIndex = 0
    while (mergeIndex + 1 < segments.length) {
      if (
        segments[mergeIndex][0] === segments[mergeIndex + 1][0] &&
        segments[mergeIndex + 1][0] !== "N"
      ) {
        segments[mergeIndex][2] = segments[mergeIndex + 1][2]
        segments.splice(mergeIndex + 1, 1)
        changed = true
      } else {
        mergeIndex += 1
      }
    }
  }

  // The latch codeword depends on the byte count before the extra byte is
  // taken, so that count is recorded separately on the segment
  const result = segments.map((segment) => [...segment])
  for (let k = 0; k < result.length - 1; k++) {
    if (
      result[k][0] === "B" &&
      result[k + 1][0] === "T" &&
      record[result[k][2] - 1] !== 6 &&
      result[k + 1][2] - result[k + 1][1] > 1
    ) {
      result[k].push(result[k][2] - result[k][1])
      result[k][2] += 1
      result[k + 1][1] += 1
    }
  }
  return result
}

function computeSymbolSize(
  contentLength,
  eccCodewordCount = 32,
  targetRows = 20,
) {
  const totalCodewords = contentLength + eccCodewordCount
  const columns = Math.ceil(totalCodewords / targetRows)
  const rows = Math.ceil(totalCodewords / columns)
  return [columns, rows, columns * rows - eccCodewordCount]
}

function generateCodeWords(
  record,
  numericMinRun = 14,
  textMinRun = 6,
  totalDataCodewords = null,
) {
  const segments = segmentRecord(record, numericMinRun, textMinRun)
  // Only known when the symbol size is chosen here; with a caller-supplied
  // total the layout is unknown and the matrix step has to infer it
  let columnCount = null
  if (totalDataCodewords === null) {
    // Encoding with a total of 1 means no padding, giving the true content length
    const contentLength = encodeSegments(record, segments, 1).length
    const [columns, , dataCodewordCount] = computeSymbolSize(contentLength)
    columnCount = columns
    totalDataCodewords = dataCodewordCount
  }
  const dataCodewords = encodeSegments(record, segments, totalDataCodewords)
  return {
    codewords: dataCodewords.concat(computeErrorCorrection(dataCodewords)),
    columnCount,
  }
}

export { generateCodeWords }
