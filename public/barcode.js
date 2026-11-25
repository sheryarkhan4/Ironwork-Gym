// Code 128 barcodes, drawn as SVG. Numeric codes with an even length use the compact
// "set C" (two digits per bar group); anything else uses set B. Works in browsers and Node.
(function (root) {
  "use strict";

  const PATTERNS = [
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
    "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
    "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
    "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
    "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
    "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
    "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
    "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
    "114131", "311141", "411131", "211412", "211214", "211232", "2331112"
  ];
  const START_B = 104, START_C = 105, STOP = 106;

  function encodeValues(text) {
    text = String(text);
    if (!text.length) throw new Error("Nothing to encode");

    const values = [];
    if (/^\d+$/.test(text) && text.length % 2 === 0) {
      values.push(START_C);
      for (let i = 0; i < text.length; i += 2) values.push(Number(text.slice(i, i + 2)));
    } else {
      values.push(START_B);
      for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (code < 32 || code > 126) throw new Error("Unsupported character: " + ch);
        values.push(code - 32);
      }
    }

    let sum = values[0];
    for (let i = 1; i < values.length; i++) sum += values[i] * i;
    values.push(sum % 103, STOP);
    return values;
  }

  function svg(text, options) {
    const o = Object.assign({ module: 1.6, height: 46 }, options || {});
    const values = encodeValues(text);
    const quiet = 10;
    let x = quiet;
    let bars = "";

    values.forEach(function (v) {
      PATTERNS[v].split("").forEach(function (digit, i) {
        const w = Number(digit);
        if (i % 2 === 0) bars += `<rect x="${x * o.module}" y="0" width="${w * o.module}" height="${o.height}"/>`;
        x += w;
      });
    });

    const width = (x + quiet) * o.module;
    const label = String(text).replace(/[^\x20-\x7E]/g, "").replace(/[<>&"]/g, "");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${o.height}" width="${width}" height="${o.height}" ` +
      `shape-rendering="crispEdges" role="img" aria-label="Barcode ${label}"><rect width="${width}" height="${o.height}" fill="#fff"/>` +
      `<g fill="#000">${bars}</g></svg>`;
  }

  const api = { PATTERNS, encodeValues, svg };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Barcode = api;
})(typeof self !== "undefined" ? self : this);