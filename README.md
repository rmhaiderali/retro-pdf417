# retro-pdf417

A PDF417 barcode **writer** (encoder only) that mimics the behaviour of the original writer used by NADRA for the barcode on Pakistani CNICs.

It takes a 400-byte record and produces a PNG barcode that matches what the original writer would produce.

> **Writer only.** This package cannot read or decode barcodes.
>
> It can also encode other kinds of data, but it is not a general-purpose PDF417 library. If you are not trying to reproduce NADRA CNIC barcodes, you are better off using [zxing-wasm](https://www.npmjs.com/package/zxing-wasm).

## Installation

```sh
npm install retro-pdf417
```

## Usage

```js
import { writeFileSync } from "node:fs"
import { generateBarcode } from "retro-pdf417"

const bytes = new TextEncoder().encode("your record data here")

const png = generateBarcode(bytes, { scale: 4 })
writeFileSync("barcode.png", png)
```

`generateBarcode` returns the PNG as a `Uint8Array`.

### Options

| Option            | Default | Description                                           |
| ----------------- | ------- | ----------------------------------------------------- |
| `scale`           | `1`     | Size of each barcode module in pixels (whole number). |
| `verticalStretch` | `0.5`   | Makes the rows taller or shorter.                     |

## Other functions

If you want to draw the barcode yourself instead of getting a PNG, you can use the lower-level steps:

```js
import { generateCodeWords, generateBitMatrix } from "retro-pdf417"

const { codewords, columnCount } = generateCodeWords(record)
const matrix = generateBitMatrix(codewords, columnCount, { scale: 4 })
// matrix is a list of rows where 1 is a dark module and 0 is light
```

## Limitations

- Hardcoded max row count 20.
- Always uses error correction level 4.
