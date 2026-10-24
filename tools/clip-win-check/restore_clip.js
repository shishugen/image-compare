// 把一张 PNG 作为「图片位图」放回系统剪贴板（用于恢复被探针覆盖的剪贴板）
// 用法：osascript -l JavaScript restore_clip.js /某张/图.png
ObjC.import("AppKit");
ObjC.import("Foundation");
function run(argv) {
  var p = argv[0];
  var data = $.NSData.dataWithContentsOfFile(p);
  if (data === $.nil) return "读不到文件: " + p;
  // JXA 不桥接 +new（报 “Object is not a function”），只能走 alloc.init
  var item = $.NSPasteboardItem.alloc.init;
  item.setDataForType(data, "public.png");
  var pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  // 不能直接传 JS 数组：JXA 会把它桥成 NSDictionary，writeObjects 会静默失败
  var ok = pb.writeObjects($.NSArray.arrayWithObject(item));
  return (ok ? "已还原剪贴板: " : "写入失败: ") + p + " (" + data.length + " 字节)";
}
