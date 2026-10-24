// 给真机探针备料：造一个「只有 public.file-url、而且只以 data 形式给」的剪贴板。
// 这正是旧写法会漏掉的那种来源——stringForType: 拿不到东西，只能按 UTF-8 解 data。
// 用法：osascript -l JavaScript onlyfileurl.js /某张/图.png   （注意：会盖掉用户当前剪贴板）
ObjC.import("AppKit");
ObjC.import("Foundation");
function run(argv) {
  var p = argv[0];
  var url = $.NSURL.fileURLWithPath(p);
  var text = url.absoluteString; // file:///... 形式
  var data = text.dataUsingEncoding(4); // NSUTF8StringEncoding
  var item = $.NSPasteboardItem.alloc.init;
  item.setDataForType(data, "public.file-url");
  var pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  var ok = pb.writeObjects($.NSArray.arrayWithObject(item));
  var t = pb.types;
  var names = [];
  for (var i = 0; i < t.count; i++) names.push(ObjC.unwrap(t.objectAtIndex(i)));
  return "ok=" + ok + "  写入=" + ObjC.unwrap(text) + "  当前风味=" + names.join(", ");
}
