# Third-party notices

Mojing Studio's application code is licensed under the root MIT License. This does not replace the licenses and copyright notices of bundled dependencies.

The offline HTML embeds the following local browser bundle and preserves its source headers. Full license texts are embedded in the HTML and distributed alongside release files.

| Component | Purpose | License / notice |
| --- | --- | --- |
| ag-psd 34.1.0 | PSD/PSB metadata and raster decoding | MIT, `vendor/ag-psd.LICENSE`; https://github.com/Agamnentzar/ag-psd |
| base64-js 1.5.1 | Binary conversion inside ag-psd's browser bundle | MIT, `vendor/licenses/base64-js.MIT.txt`; https://github.com/beatgammit/base64-js |
| buffer browser polyfill | Buffer compatibility inside the browser bundle | MIT, `vendor/licenses/buffer.MIT.txt`; https://github.com/feross/buffer |
| ieee754 browser helper | Numeric binary conversion inside the browser bundle | BSD-3-Clause, `vendor/licenses/ieee754.BSD-3-Clause.txt`; https://github.com/feross/ieee754 |
| pako 2.1.0 and its zlib port | PSD compression handling | MIT and Zlib, `vendor/licenses/pako.MIT-Zlib.txt` and the retained Zlib source notices in `vendor/ag-psd.js`; https://github.com/nodeca/pako |
| JPEG decoding and CMYK conversion code within ag-psd | PSD image and approximate color decoding | Apache-2.0; copyright headers remain in the bundle; full terms in `vendor/licenses/Apache-2.0.txt` |

The JPEG decoder retains the notice "Copyright 2011 notmasteryet". The CMYK conversion coefficients retain attribution to PDF.js, Copyright 2012 Mozilla Foundation. This attribution does not bundle a separate PDF document runtime.

The Zlib port retains notices for Jean-loup Gailly, Mark Adler, Vitaly Puzrin and Andrey Tupitsin in its source. The browser bundle is redistributed without project-specific parser changes.

## Development dependencies

`@napi-rs/canvas` (MIT) is used only by development tests and fixture generation. The npm `ag-psd` package is used by fixture generation. Neither requires a separate download when someone runs the delivered standalone HTML. `package-lock.json` pins the development dependency tree; each installed package retains its own notices.

## Samples and screenshots

`src/demo.psd` and the files under `tests/` are self-generated demonstration/format probes supplied with this project. The matching generators are included. No client design sources, bundled fonts or external stock photos are distributed. Documentation screenshots use these generated examples. Do not add private or third-party artwork to the repository without permission.
