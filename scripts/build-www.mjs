// Tạo thư mục www cho app Capacitor từ bản web, dùng thư viện cục bộ thay cho CDN để đọc được khi offline.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "www");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "vendor"), { recursive: true });

for (const file of ["index.html", "app.js", "converters.js", "translator.js", "styles.css", "book.svg", "site.webmanifest"]) {
  cpSync(join(root, file), join(out, file));
}
cpSync(join(root, "vendor"), join(out, "vendor"), { recursive: true });
if (existsSync(join(root, "icons"))) cpSync(join(root, "icons"), join(out, "icons"), { recursive: true });

const modules = join(root, "node_modules");
const vendor = {
  "jszip.min.js": join(modules, "jszip/dist/jszip.min.js"),
  "epub.min.js": join(modules, "epubjs/dist/epub.min.js"),
  "capacitor.js": join(modules, "@capacitor/core/dist/capacitor.js"),
};
for (const [name, source] of Object.entries(vendor)) cpSync(source, join(out, "vendor", name));

let html = readFileSync(join(out, "index.html"), "utf8");
const replacements = [
  [/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/jszip@[^"]+"><\/script>/, '<script src="vendor/jszip.min.js"></script>'],
  [/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/epubjs@[^"]+"><\/script>/, '<script src="vendor/epub.min.js"></script>\n    <script src="vendor/capacitor.js"></script>'],
];
for (const [pattern, replacement] of replacements) {
  if (!pattern.test(html)) throw new Error(`Không tìm thấy thẻ script cần thay: ${pattern}`);
  html = html.replace(pattern, replacement);
}
writeFileSync(join(out, "index.html"), html);
console.log("Đã tạo www/");
