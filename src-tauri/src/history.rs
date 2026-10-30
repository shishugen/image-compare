//! 查看历史：侧栏的默认源，只记「在本机哪张图上停过」。
//!
//! 只存绝对路径与最后查看时刻，不存 name/size —— 那些存了就会过期（改名、
//! 体积变化后显示旧值），name 能从 path 现算，size 那一格改用时刻更有用。
//!
//! 写入口径全在这一侧（去重置顶 + 截断到 `HISTORY_MAX` 是单一实现），前端只发
//! 一条路径，并把返回值直接拿来渲染 —— 省掉「写完再读一遍」的往返，也排除
//! 两份列表顺序不一致的可能。

use crate::store::{self, HistoryFile, Store};
use std::path::Path;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_history(store: State<'_, Arc<Store>>) -> HistoryFile {
    store.load_history()
}

/// 记一次查看，返回整份新列表。读失败的图片不该走到这里（前端只在真的
/// 载入显示成功时才调用），所以这里不判文件是否存在 —— 外置盘没挂载时
/// 记录得留着，等它回来。
#[tauri::command]
pub fn record_view(store: State<'_, Arc<Store>>, path: String) -> Result<HistoryFile, String> {
    record(store.inner(), &path)
}

#[tauri::command]
pub fn clear_history(store: State<'_, Arc<Store>>) -> Result<(), String> {
    // 只支持整份清空，不做单条删除：那需要一整套行的增删 UI，而「清掉重来」
    // 已经覆盖了唯一的真实需求（看过的都翻完了、或者攒了一批没用的粘贴图）
    store.inner().save_history(&HistoryFile::default())
}

/// 归类移动文件后修正查看历史：一批 (旧路径, 新路径) 原地换新，不置顶不重排。
///
/// 与 `record` 不同，这不是「又看了一次」，只是路径变了 —— 所以走
/// `HistoryFile::rename_paths` 而不是逐条 `record`（那样会把刚移动的那几张顶到最前，
/// 侧栏顺序会莫名其妙地打乱）。读写都是整份，一次拿全再存回。
pub fn rename_paths(store: &Store, pairs: &[(String, String)]) -> Result<(), String> {
    if pairs.is_empty() {
        return Ok(());
    }
    let mut h = store.load_history();
    h.rename_paths(pairs);
    store.save_history(&h)
}

fn record(store: &Store, path: &str) -> Result<HistoryFile, String> {
    // 明确报错而不是静默收下：前端传了相对路径是实现写错了，吞掉的话
    // 「以为记了其实没记」比崩掉难查得多（同 `set_prefs` 的口径）
    if path.is_empty() {
        return Err("记录查看失败：路径为空".into());
    }
    // 相对路径会相对于进程当前目录去解析，那个地方从 Finder 双击启动和从
    // cargo 启动完全不是一个 —— 记进去就是一条永远点不开的僵尸行
    if !Path::new(path).is_absolute() {
        return Err(format!("记录查看失败：不是绝对路径: {path}"));
    }
    let mut h = store.load_history();
    h.record(path, store::now_ms());
    store.save_history(&h)?;
    Ok(h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::HistoryItem;

    /// 每个用例一个独立目录：这几个测试会并行跑，共用一个目录会互相盖掉文件
    fn 临时存储(名字: &str) -> Store {
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Store::new(std::env::temp_dir().join(format!("imgcmp-histcmd-{名字}-{}-{n}", std::process::id())))
    }

    fn 条目(path: String, seen: i64) -> HistoryItem {
        HistoryItem { path, seen }
    }

    #[test]
    fn 空路径与相对路径被明确拒绝且不落盘() {
        let s = 临时存储("reject");
        for 坏 in ["", "a.jpg", "./a.jpg", "recv/今日.png"] {
            let e = record(&s, 坏).expect_err(&format!("{坏:?} 应被拒绝"));
            assert!(e.contains("绝对路径") || e.contains("为空"), "报错要说清为什么拒: {e}");
        }
        // 拒了就不该写出文件来，否则下次启动会读到一份半空的历史
        assert!(s.load_history().items.is_empty());
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 记录后重读是同一份且重复查看只置顶() {
        let s = 临时存储("record-roundtrip");
        std::fs::create_dir_all(&s.dir).unwrap();

        let after = record(&s, "/a/1.jpg").unwrap();
        assert_eq!(after.items.len(), 1);
        assert_eq!(after.items[0].path, "/a/1.jpg");
        assert!(after.items[0].seen > 0, "记录要带时刻");

        record(&s, "/a/2.jpg").unwrap();
        let back = s.load_history();
        assert_eq!(back.items[0].path, "/a/2.jpg", "新的在前");
        assert_eq!(back.items[1].path, "/a/1.jpg");

        // 同一张再看一次：列表不多出第二条，它跑到最前
        let again = record(&s, "/a/1.jpg").unwrap();
        assert_eq!(again.items.len(), 2, "同一张只留一条");
        assert_eq!(again.items[0].path, "/a/1.jpg", "重复查看置顶");
        assert_eq!(s.load_history().items.len(), 2, "落盘份也是置顶的那份");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 看满上限后最旧的掉出去() {
        let s = 临时存储("cap");
        std::fs::create_dir_all(&s.dir).unwrap();
        for i in 0..(store::HISTORY_MAX + 5) {
            record(&s, &format!("/a/{i:04}.jpg")).unwrap();
        }
        let h = s.load_history();
        assert_eq!(h.items.len(), store::HISTORY_MAX, "封顶不因新记录而突破");
        assert_eq!(h.items[0].path, "/a/0104.jpg", "最后看的在第一位");
        assert!(
            !h.items.iter().any(|it| it.path == "/a/0000.jpg"),
            "最早那几条已经被挤出去了"
        );
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 清空后重读为空列表() {
        let s = 临时存储("clear");
        std::fs::create_dir_all(&s.dir).unwrap();
        record(&s, "/a/1.jpg").unwrap();
        record(&s, "/a/2.jpg").unwrap();

        s.save_history(&HistoryFile::default()).unwrap();
        assert!(s.load_history().items.is_empty(), "清空要真的清干净，下次启动还是空的");

        // 清完再记一条，是从空列表开始而非把旧的捞回来
        let h = record(&s, "/a/3.jpg").unwrap();
        assert_eq!(h.items.len(), 1);
        assert_eq!(h.items[0].path, "/a/3.jpg");
        let _ = std::fs::remove_dir_all(&s.dir);
    }

    #[test]
    fn 手改出脏数据时读一次就收敛成合法份() {
        let s = 临时存储("dirty");
        std::fs::create_dir_all(&s.dir).unwrap();
        // 模拟用户手改 history.json：空路径、相对路径、重复条目、乱序、超上限
        let mut 脏 = HistoryFile::default();
        for i in 0..(store::HISTORY_MAX + 3) {
            脏.items.push(条目(format!("/a/{i:04}.jpg"), 1));
        }
        脏.items.push(条目("/a/0001.jpg".into(), 5));
        脏.items.push(条目("a.jpg".into(), 9));
        脏.items.push(条目(String::new(), 9));
        s.save_history(&脏).unwrap();

        let h = s.load_history();
        assert_eq!(h.items.len(), store::HISTORY_MAX, "超上限 + 重复要先去掉重的再截");
        assert!(h.items.iter().all(|it| it.path.starts_with('/')), "相对路径与空路径都清了");
        assert_eq!(h.items[0].path, "/a/0001.jpg", "重复的那条留 seen 大的，排到最前");
        assert_eq!(h.items.iter().filter(|it| it.path == "/a/0001.jpg").count(), 1);
        // 写回一次就是干净份：再记一条不会因为脏数据把顺序打乱
        let h2 = record(&s, "/a/new.jpg").unwrap();
        assert_eq!(h2.items[0].path, "/a/new.jpg");
        assert_eq!(h2.items.len(), store::HISTORY_MAX);
        let _ = std::fs::remove_dir_all(&s.dir);
    }
}
