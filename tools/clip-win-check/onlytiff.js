/*
 * 真机探针的备料：往剪贴板里只放 TIFF 数据。
 *
 * 为什么需要它：osascript 的 `set the clipboard to (read … as «class TIFF»)` 会顺手
 * 把 PNG/JPEG/BMP 等派生类型一起补上，而 clip.rs 是先查 public.png 的——那样永远试不到
 * 「只有 TIFF」这条分岔（⌘⇧4 截图进剪贴板走的正是它）。这里用 JXA 直接调 NSPasteboard
 * 的 setData:forType:，只声明 TIFF 一种类型。
 *
 * 跑法：osascript -l JavaScript tools/clip-win-check/onlytiff.js /某张/图.tiff
 * 然后：cd src-tauri && cargo test --lib -- --ignored clip::real_clipboard
 */
ObjC.import("AppKit");
ObjC.import("Foundation");

function run(argv) {
  if (!argv || !argv.length) throw "用法: onlytiff.js <tiff 文件路径>";
  const data = $.NSData.dataWithContentsOfFile(argv[0]);
  if (data.isNil()) throw "读不到文件: " + argv[0];
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  pb.setDataForType(data, $.NSPasteboardTypeTIFF);
  return "剪贴板现在只有 TIFF，" + data.length + " 字节";
}
