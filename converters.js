// Chuyển các định dạng sách khác (TXT, MOBI/PRC/AZW3, FB2, DOCX, HTML) thành EPUB ngay trên máy,
// để dùng chung trình đọc epub.js, mục lục, lưu vị trí và giọng đọc.
(() => {
  "use strict";

  const SUPPORTED_EXTENSIONS = /\.(epub|txt|text|mobi|prc|azw3?|fb2|fbz|zip|docx|html?|xhtml)$/i;
  const ZIP_SIGNATURE = [0x50, 0x4b];
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

  const escapeXml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);

  function stripExtension(name) {
    return String(name || "").replace(/\.(fb2\.zip|[a-z0-9]+)$/i, "");
  }

  function isSupported(name) {
    return SUPPORTED_EXTENSIONS.test(name || "");
  }

  // ---------- Giải mã chữ ----------

  function decodeWith(bytes, encoding) {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      return null;
    }
  }

  function latin1Head(bytes, length = 2048) {
    return String.fromCharCode(...bytes.subarray(0, Math.min(length, bytes.length)));
  }

  /** Nhận diện mã hóa rồi chuẩn hóa về NFC (Windows-1258 lưu dấu thanh tách rời khỏi chữ). */
  function decodeText(bytes, declared) {
    return detectAndDecode(bytes, declared).normalize("NFC");
  }

  /** Thứ tự thử: BOM, mã hóa khai báo, UTF-16 không BOM, UTF-8, rồi Windows-1258 (tiếng Việt cũ). */
  function detectAndDecode(bytes, declared) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    if (declared && !/^utf-?8$/i.test(declared)) {
      const text = decodeWith(bytes, declared);
      if (text !== null) return text;
    }
    const sample = bytes.subarray(0, Math.min(bytes.length, 4000));
    let evenZeros = 0;
    let oddZeros = 0;
    for (let i = 0; i < sample.length; i += 1) {
      if (sample[i] === 0) {
        if (i % 2) oddZeros += 1;
        else evenZeros += 1;
      }
    }
    if (oddZeros > sample.length / 8) return new TextDecoder("utf-16le").decode(bytes);
    if (evenZeros > sample.length / 8) return new TextDecoder("utf-16be").decode(bytes);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return decodeWith(bytes, "windows-1258") ?? new TextDecoder("utf-8").decode(bytes);
    }
  }

  // ---------- Dựng EPUB ----------

  function guessImageType(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return ["image/jpeg", "jpg"];
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return ["image/png", "png"];
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return ["image/gif", "gif"];
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return ["image/webp", "webp"];
    if (latin1Head(bytes, 200).includes("<svg")) return ["image/svg+xml", "svg"];
    return null;
  }

  function chapterFile(index) {
    return `c${String(index + 1).padStart(4, "0")}.xhtml`;
  }

  function xhtmlPage(title, body, lang, head = "") {
    return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="${HTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">`
      + `<head><meta charset="utf-8"/><title>${escapeXml(title)}</title>${head}</head><body>${body}</body></html>`;
  }

  function navList(items) {
    if (!items?.length) return "";
    return `<ol>${items.map((item) => `<li><a href="text/${escapeXml(item.href)}">${escapeXml(item.label || "Chương")}</a>${navList(item.subitems)}</li>`).join("")}</ol>`;
  }

  /**
   * chapters: [{ title, body (chuỗi XHTML trong <body>), head? }]
   * images: [{ path: "images/x.jpg", data: Uint8Array, mediaType }]
   * toc: [{ label, href: "c0001.xhtml#id", subitems? }] — mặc định lấy theo chương.
   */
  async function buildEpub({ title, author, language, chapters, images = [], toc }) {
    if (typeof window.JSZip !== "function") throw new Error("Không tải được thư viện giải nén (JSZip).");
    const lang = language || "vi";
    const zip = new window.JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", '<?xml version="1.0" encoding="utf-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');

    const manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'];
    const spine = [];
    chapters.forEach((chapter, index) => {
      const file = chapterFile(index);
      zip.file(`OEBPS/text/${file}`, xhtmlPage(chapter.title || `Chương ${index + 1}`, chapter.body, lang, chapter.head || ""));
      manifest.push(`<item id="c${index + 1}" href="text/${file}" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="c${index + 1}"/>`);
    });
    images.forEach((image, index) => {
      zip.file(`OEBPS/${image.path}`, image.data);
      manifest.push(`<item id="img${index + 1}" href="${escapeXml(image.path)}" media-type="${image.mediaType}"/>`);
    });

    const tocItems = toc?.length
      ? toc
      : chapters.map((chapter, index) => ({ label: chapter.title || `Chương ${index + 1}`, href: chapterFile(index) }));
    zip.file("OEBPS/nav.xhtml", xhtmlPage("Mục lục", `<nav epub:type="toc" id="toc"><h1>Mục lục</h1>${navList(tocItems)}</nav>`, lang));

    const id = `urn:uuid:${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
    const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXml(lang)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${escapeXml(id)}</dc:identifier>
<dc:title>${escapeXml(title || "Sách không tên")}</dc:title>
${author ? `<dc:creator>${escapeXml(author)}</dc:creator>` : ""}
<dc:language>${escapeXml(lang)}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>${manifest.join("")}</manifest>
<spine>${spine.join("")}</spine>
</package>`);
    return zip.generateAsync({ type: "arraybuffer", mimeType: "application/epub+zip" });
  }

  // ---------- Tiện ích DOM ----------

  const serializer = new XMLSerializer();
  const VALID_ATTR = /^[A-Za-z_][\w.-]*$/;

  /** Bỏ phần tử/thuộc tính không an toàn hoặc không hợp lệ trong XHTML. */
  function sanitize(root) {
    for (const node of root.querySelectorAll("script, noscript, iframe, object, embed, form, input, button, select, textarea, link, meta, base")) node.remove();
    // Thẻ có tiền tố (vd. <o:p> của Word) không hợp lệ trong XHTML: giữ nội dung, bỏ thẻ.
    for (const el of [...root.querySelectorAll("*")].reverse()) {
      if (el.localName.includes(":")) el.replaceWith(...el.childNodes);
    }
    for (const el of root.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        const name = attr.name;
        if (/^on/i.test(name) || !VALID_ATTR.test(name.replace(/^(xml|xlink|epub):/, ""))
          || (/^(href|src|xlink:href)$/i.test(name) && /^\s*javascript:/i.test(attr.value))) {
          el.removeAttribute(name);
        }
      }
    }
  }

  function serializeChildren(node) {
    return [...node.childNodes].map((child) => serializer.serializeToString(child)).join("");
  }

  function headingText(el) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  /** Chia <body> HTML thành các chương theo tiêu đề (h1, rồi h2, rồi h3), giữ đúng cấu trúc lồng nhau. */
  function splitHtmlBody(body, fallbackTitle) {
    let headings = [];
    for (const selector of ["h1", "h2", "h3"]) {
      headings = [...body.querySelectorAll(selector)].filter((el) => headingText(el));
      if (headings.length >= 2) break;
    }
    if (headings.length < 2) return [{ title: headingText(body.querySelector("h1, h2, h3")) || fallbackTitle, body: serializeChildren(body) }];

    const doc = body.ownerDocument;
    const chapters = [];
    const pushRange = (start, end, title) => {
      const range = doc.createRange();
      if (start) range.setStartBefore(start);
      else range.setStart(body, 0);
      if (end) range.setEndBefore(end);
      else range.setEnd(body, body.childNodes.length);
      const fragment = range.cloneContents();
      const holder = doc.createElement("div");
      holder.append(fragment);
      if (!holder.textContent.trim() && !holder.querySelector("img")) return;
      chapters.push({ title, body: serializeChildren(holder) });
    };
    pushRange(null, headings[0], "Mở đầu");
    headings.forEach((heading, index) => pushRange(heading, headings[index + 1], headingText(heading)));
    return chapters;
  }

  // ---------- TXT ----------

  const TXT_HEADING = /^(?:(?:chương|chuong|hồi|quyển|quyen|phần|tập|tiết|chapter|chap|part|book|volume|vol\.?)\s*[0-9IVXLCDMivxlcdm]+(?=$|[\s:.\-–—)])|(?:đệ|de)\s+\S+\s+(?:chương|hồi)|第\s*[0-9零〇一二三四五六七八九十百千两]+\s*[章回节卷]|(?:mở đầu|lời mở đầu|lời tựa|lời nói đầu|phần kết|ngoại truyện|phiên ngoại|vĩ thanh|prologue|epilogue)(?=$|[\s:.\-–—]))/iu;

  function txtToChapters(text, fallbackTitle) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/\s+$/, ""));
    const isHeading = (line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && trimmed.length <= 100 && TXT_HEADING.test(trimmed);
    };
    const headingCount = lines.filter(isHeading).length;
    const paragraph = (line) => `<p>${escapeXml(line.trim())}</p>`;

    if (headingCount >= 2) {
      const chapters = [];
      let current = { title: "Mở đầu", parts: [] };
      for (const line of lines) {
        if (isHeading(line)) {
          if (current.parts.length) chapters.push(current);
          current = { title: line.trim(), parts: [`<h2>${escapeXml(line.trim())}</h2>`] };
        } else if (line.trim()) {
          current.parts.push(paragraph(line));
        }
      }
      if (current.parts.length) chapters.push(current);
      return chapters.map((chapter) => ({ title: chapter.title, body: chapter.parts.join("\n") }));
    }

    // Không có tiêu đề chương: chia theo độ dài, cắt ở ranh giới đoạn.
    const chapters = [];
    let parts = [];
    let size = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      parts.push(paragraph(line));
      size += line.length;
      if (size >= 15000) {
        chapters.push(parts);
        parts = [];
        size = 0;
      }
    }
    if (parts.length) chapters.push(parts);
    if (chapters.length === 1) return [{ title: fallbackTitle, body: chapters[0].join("\n") }];
    return chapters.map((chapterParts, index) => ({ title: `Phần ${index + 1}`, body: chapterParts.join("\n") }));
  }

  async function convertTxt(bytes, name) {
    const title = stripExtension(name);
    const chapters = txtToChapters(decodeText(bytes), title);
    if (!chapters.length) throw new Error("Tệp văn bản không có nội dung.");
    return buildEpub({ title, chapters });
  }

  // ---------- HTML ----------

  function htmlCharset(bytes) {
    const head = latin1Head(bytes);
    return head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1];
  }

  async function convertHtml(bytes, name) {
    const doc = new DOMParser().parseFromString(decodeText(bytes, htmlCharset(bytes)), "text/html");
    sanitize(doc.body);
    // Ảnh tham chiếu file bên ngoài không có trong tệp: bỏ đi, chỉ giữ ảnh nhúng sẵn (data:).
    for (const img of doc.body.querySelectorAll("img")) {
      if (!/^data:image\//i.test(img.getAttribute("src") || "")) img.remove();
    }
    const title = doc.title?.trim() || stripExtension(name);
    const lang = doc.documentElement.getAttribute("lang") || "vi";
    const chapters = splitHtmlBody(doc.body, title);
    return buildEpub({ title, language: lang, chapters });
  }

  // ---------- DOCX ----------

  async function convertDocx(zip, name) {
    const parse = (xml) => new DOMParser().parseFromString(xml, "application/xml");
    const documentXml = await zip.file("word/document.xml")?.async("string");
    if (!documentXml) throw new Error("Tệp Word không hợp lệ.");
    const stylesXml = await zip.file("word/styles.xml")?.async("string");
    const attr = (el, local) => el?.getAttributeNS(W_NS, local) ?? el?.getAttribute(`w:${local}`);
    const child = (el, local) => el ? [...el.children].find((node) => node.localName === local) : null;

    // Mức tiêu đề của từng style: dùng outlineLvl hoặc tên "heading N" / "Title".
    const styleLevels = new Map();
    if (stylesXml) {
      for (const style of parse(stylesXml).getElementsByTagNameNS(W_NS, "style")) {
        const id = attr(style, "styleId");
        const outline = attr(child(child(style, "pPr"), "outlineLvl"), "val");
        const styleName = attr(child(style, "name"), "val") || "";
        let level = outline != null ? Number(outline) : null;
        if (level == null) {
          const match = styleName.match(/^heading\s*(\d)$/i);
          if (match) level = Number(match[1]) - 1;
          else if (/^title$/i.test(styleName)) level = 0;
        }
        if (id && level != null && level < 6) styleLevels.set(id, level);
      }
    }

    const doc = parse(documentXml);
    const html = [];
    let title = "";
    for (const p of doc.getElementsByTagNameNS(W_NS, "p")) {
      if ([...ancestors(p)].some((node) => node.localName === "Fallback")) continue;
      const pPr = child(p, "pPr");
      const styleId = attr(child(pPr, "pStyle"), "val");
      const outline = attr(child(pPr, "outlineLvl"), "val");
      const level = outline != null ? Number(outline) : styleLevels.get(styleId);
      let text = "";
      for (const run of p.getElementsByTagNameNS(W_NS, "r")) {
        if ([...ancestors(run)].find((node) => node.localName === "p") !== p) continue;
        let runText = "";
        for (const node of run.children) {
          if (node.localName === "t") runText += escapeXml(node.textContent);
          else if (node.localName === "tab") runText += " ";
          else if (node.localName === "br" || node.localName === "cr") runText += "<br/>";
        }
        if (!runText) continue;
        const rPr = child(run, "rPr");
        const on = (local) => {
          const flag = child(rPr, local);
          return flag && !/^(0|false)$/i.test(attr(flag, "val") || "");
        };
        if (on("b")) runText = `<strong>${runText}</strong>`;
        if (on("i")) runText = `<em>${runText}</em>`;
        text += runText;
      }
      if (!text.replace(/<br\/>/g, "").trim()) continue;
      if (level != null && level < 6) {
        const tag = `h${Math.min(level + 1, 6)}`;
        if (!title && level === 0) title = text.replace(/<[^>]+>/g, "");
        html.push(`<${tag}>${text}</${tag}>`);
      } else {
        html.push(`<p>${text}</p>`);
      }
    }
    const bookTitle = title.trim() || stripExtension(name);
    const htmlDoc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html.join("")}</body></html>`, "text/html");
    return buildEpub({ title: bookTitle, chapters: splitHtmlBody(htmlDoc.body, bookTitle) });
  }

  function* ancestors(node) {
    for (let current = node.parentNode; current; current = current.parentNode) yield current;
  }

  // ---------- FB2 ----------

  function xmlEncoding(bytes) {
    return latin1Head(bytes, 200).match(/encoding\s*=\s*["']([\w-]+)["']/i)?.[1];
  }

  async function convertFb2(bytes, name) {
    const text = decodeText(bytes, xmlEncoding(bytes));
    const xml = new DOMParser().parseFromString(text, "application/xml");
    if (xml.querySelector("parsererror")) throw new Error("Tệp FB2 bị lỗi cấu trúc.");
    const root = xml.documentElement;
    const kids = (el, local) => el ? [...el.children].filter((node) => node.localName === local) : [];
    const first = (el, local) => kids(el, local)[0] || null;
    const textOf = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
    const href = (el) => el.getAttribute("l:href") || el.getAttribute("xlink:href")
      || el.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";

    const titleInfo = first(first(root, "description"), "title-info");
    const title = textOf(first(titleInfo, "book-title")) || stripExtension(name);
    const authorEl = first(titleInfo, "author");
    const author = authorEl
      ? ["first-name", "middle-name", "last-name"].map((part) => textOf(first(authorEl, part))).filter(Boolean).join(" ") || textOf(first(authorEl, "nickname"))
      : "";
    const language = textOf(first(titleInfo, "lang")) || "vi";

    // Ảnh nhúng dạng base64.
    const images = [];
    const imagePaths = new Map();
    for (const binary of kids(root, "binary")) {
      const id = binary.getAttribute("id");
      if (!id) continue;
      try {
        const raw = atob(binary.textContent.replace(/\s+/g, ""));
        const data = Uint8Array.from(raw, (char) => char.charCodeAt(0));
        const type = guessImageType(data) || [binary.getAttribute("content-type") || "image/jpeg", "img"];
        const path = `images/${images.length + 1}.${type[1]}`;
        images.push({ path, data, mediaType: type[0] });
        imagePaths.set(id, path);
      } catch {
        // Bỏ qua ảnh hỏng.
      }
    }

    const out = document.implementation.createHTMLDocument("");
    const idToChapter = new Map();
    let chapterIndex = 0;
    const convert = (node, depth) => {
      if (node.nodeType === Node.TEXT_NODE) return out.createTextNode(node.textContent);
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const map = {
        p: "p", v: "p", "text-author": "p", subtitle: "h4", emphasis: "em", strong: "strong",
        strikethrough: "s", sub: "sub", sup: "sup", code: "code", epigraph: "blockquote", cite: "blockquote",
        poem: "div", stanza: "div", section: "section", table: "table", tr: "tr", td: "td", th: "th", annotation: "div",
      };
      let el;
      if (node.localName === "title") {
        el = out.createElement(`h${Math.min(depth + 1, 6)}`);
        el.textContent = textOf(node);
        return el;
      }
      if (node.localName === "empty-line") return out.createElement("br");
      if (node.localName === "image") {
        const path = imagePaths.get(href(node).replace(/^#/, ""));
        if (!path) return null;
        el = out.createElement("img");
        el.setAttribute("src", `../${path}`);
        el.setAttribute("alt", "");
        return el;
      }
      if (node.localName === "a") {
        el = out.createElement("a");
        el.setAttribute("href", href(node));
      } else {
        el = out.createElement(map[node.localName] || "span");
      }
      const id = node.getAttribute("id");
      if (id) {
        el.setAttribute("id", id);
        idToChapter.set(id, chapterIndex);
      }
      for (const childNode of node.childNodes) {
        const converted = convert(childNode, node.localName === "section" ? depth + 1 : depth);
        if (converted) el.append(converted);
      }
      return el;
    };

    const chapters = [];
    const bodies = kids(root, "body");
    for (const body of bodies) {
      const isNotes = /notes|comments/i.test(body.getAttribute("name") || "");
      const sections = kids(body, "section");
      const units = isNotes || !sections.length ? [body] : sections;
      for (const unit of units) {
        chapterIndex = chapters.length;
        const holder = out.createElement("div");
        for (const childNode of unit.childNodes) {
          const converted = convert(childNode, 1);
          if (converted) holder.append(converted);
        }
        const chapterTitle = isNotes ? "Chú thích" : textOf(first(unit, "title")) || (unit === body ? title : `Chương ${chapters.length + 1}`);
        chapters.push({ title: chapterTitle, holder });
      }
    }
    if (!chapters.length) throw new Error("Tệp FB2 không có nội dung.");

    // Sửa liên kết nội bộ (#chu-thich) thành đường dẫn tới đúng file chương.
    for (const chapter of chapters) {
      for (const link of chapter.holder.querySelectorAll('a[href^="#"]')) {
        const target = link.getAttribute("href").slice(1);
        if (idToChapter.has(target)) link.setAttribute("href", `${chapterFile(idToChapter.get(target))}#${target}`);
      }
    }
    return buildEpub({
      title,
      author,
      language,
      images,
      chapters: chapters.map((chapter) => ({ title: chapter.title, body: serializeChildren(chapter.holder) })),
    });
  }

  // ---------- MOBI / PRC / AZW3 ----------

  async function convertMobi(buffer, name) {
    const { MOBI } = await import(new URL("vendor/foliate-mobi.js", document.baseURI).href);
    // Đọc thẳng từ bộ nhớ thay vì cắt nhiều lát Blob (chậm/treo trên một số trình duyệt).
    const source = {
      size: buffer.byteLength,
      slice: (start, end) => ({ arrayBuffer: async () => buffer.slice(start, end) }),
    };
    const mobiBook = await new MOBI({
      unzlib: async () => {
        throw new Error("Không hỗ trợ phông chữ nhúng.");
      },
    }).open(source);
    if (mobiBook.mobi?.headers?.palmdoc?.encryption) {
      throw new Error("Sách này có DRM (khóa bản quyền) nên không mở được. Hãy dùng bản không khóa.");
    }

    const parser = new DOMParser();
    const docs = [];
    for (const section of mobiBook.sections) {
      if (!section.load) {
        docs.push(null);
        continue;
      }
      const url = await section.load();
      const html = await (await fetch(url)).text();
      docs.push(parser.parseFromString(html, "text/html"));
    }

    // Ảnh và CSS đang ở dạng blob: — nhúng vào EPUB.
    const images = [];
    const imagePaths = new Map();
    const embedImage = async (url) => {
      if (imagePaths.has(url)) return imagePaths.get(url);
      let path = null;
      try {
        const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
        const type = guessImageType(data);
        if (type) {
          path = `images/${images.length + 1}.${type[1]}`;
          images.push({ path, data, mediaType: type[0] });
        }
      } catch {
        // Bỏ qua ảnh hỏng.
      }
      imagePaths.set(url, path);
      return path;
    };

    let autoId = 0;
    const ensureId = (el) => {
      if (!el.id) el.id = `m${(autoId += 1)}`;
      return el.id;
    };
    const keptIndexes = docs.map((doc, index) => (doc ? index : -1)).filter((index) => index >= 0);
    const fileForSection = (index) => chapterFile(keptIndexes.indexOf(index));
    const resolve = async (href) => {
      try {
        const resolved = await mobiBook.resolveHref(href);
        if (!resolved || !docs[resolved.index]) return null;
        const target = resolved.anchor?.(docs[resolved.index]);
        return `${fileForSection(resolved.index)}${target ? `#${ensureId(target)}` : ""}`;
      } catch {
        return null;
      }
    };

    for (const doc of docs) {
      if (!doc) continue;
      for (const img of doc.querySelectorAll("img[src], image")) {
        const attrName = img.localName === "image" ? (img.hasAttribute("href") ? "href" : "xlink:href") : "src";
        const src = img.getAttribute(attrName) || "";
        if (!src.startsWith("blob:")) continue;
        const path = await embedImage(src);
        if (path) img.setAttribute(attrName, `../${path}`);
        else img.remove();
      }
      for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href^="blob:"]')) {
        try {
          const css = (await (await fetch(link.getAttribute("href"))).text()).replace(/url\(\s*["']?blob:[^)]*\)/g, "none");
          const style = doc.createElement("style");
          style.textContent = css;
          doc.head.append(style);
        } catch {
          // Bỏ qua CSS hỏng.
        }
      }
    }
    for (const doc of docs) {
      if (!doc) continue;
      for (const link of doc.querySelectorAll("a[href]")) {
        const value = link.getAttribute("href");
        if (/^(https?|mailto):/i.test(value)) continue;
        const target = await resolve(value);
        if (target) link.setAttribute("href", target);
        else link.removeAttribute("href");
      }
    }

    const tocItems = [];
    const walk = async (items, list) => {
      for (const item of items || []) {
        const href = await resolve(item.href);
        const entry = { label: item.label || "Chương", href: href || fileForSection(keptIndexes[0]), subitems: [] };
        await walk(item.subitems, entry.subitems);
        list.push(entry);
      }
    };
    await walk(mobiBook.toc, tocItems);

    const chapters = keptIndexes.map((index, position) => {
      const doc = docs[index];
      sanitize(doc.body);
      const styles = [...doc.querySelectorAll("style")].map((style) => `<style>${escapeXml(style.textContent)}</style>`).join("");
      return {
        title: headingText(doc.body.querySelector("h1, h2, h3")) || `Phần ${position + 1}`,
        head: styles,
        body: serializeChildren(doc.body),
      };
    });
    const meta = mobiBook.metadata || {};
    mobiBook.destroy?.();
    return buildEpub({
      title: meta.title || stripExtension(name),
      author: Array.isArray(meta.author) ? meta.author.join(", ") : meta.author,
      language: Array.isArray(meta.language) ? meta.language[0] : meta.language,
      chapters,
      images,
      toc: tocItems.length ? tocItems : undefined,
    });
  }

  // ---------- Điểm vào ----------

  /** Trả về dữ liệu EPUB (ArrayBuffer) cho tệp sách bất kỳ được hỗ trợ. */
  async function toEpub(file) {
    const name = file.name || "";
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const isZip = bytes[0] === ZIP_SIGNATURE[0] && bytes[1] === ZIP_SIGNATURE[1];

    if (latin1Head(bytes, 68).slice(60, 68) === "BOOKMOBI") return convertMobi(buffer, name);
    if (isZip) {
      if (/\.epub$/i.test(name)) return buffer;
      const zip = await window.JSZip.loadAsync(buffer);
      if (zip.file("word/document.xml")) return convertDocx(zip, name);
      const fb2Entry = Object.values(zip.files).find((entry) => /\.fb2$/i.test(entry.name));
      if (fb2Entry) return convertFb2(new Uint8Array(await fb2Entry.async("uint8array")), fb2Entry.name);
      if (zip.file("META-INF/container.xml") || zip.file("mimetype")) return buffer;
      throw new Error("Tệp nén này không chứa sách EPUB, FB2 hoặc Word.");
    }
    const head = latin1Head(bytes, 1024);
    if (/\.fb2$/i.test(name) || /<FictionBook/i.test(head)) return convertFb2(bytes, name);
    if (/\.(x?html?)$/i.test(name) || /<(!doctype html|html)/i.test(head)) return convertHtml(bytes, name);
    if (/\.(mobi|prc|azw3?)$/i.test(name)) throw new Error("Tệp Kindle này không đúng cấu trúc MOBI nên không đọc được.");
    return convertTxt(bytes, name);
  }

  window.BookConverters = { isSupported, stripExtension, toEpub };
})();
