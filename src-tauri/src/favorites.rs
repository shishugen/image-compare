//! 三级文字收藏：分类树 + 条目的读写与守卫。
//!
//! 数据只有一个 JSON 文件（favorites.json），节点用 parent 指针串成树，
//! 整份读进内存后由前端构树 —— 个人收藏量级下不必做增量索引。
//! 硬约束：分类（kind="cat"）最多三级，条目（kind="fav"）只能挂在分类下。

use crate::store::{self, FavFile, FavNode, Store};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::State;

/// 分类最大层级
const MAX_CAT_LEVEL: usize = 3;
const MAX_TITLE_CHARS: usize = 200;

/// 前端提交的节点：不带 id 表示新建
#[derive(Deserialize)]
pub struct FavInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub parent: Option<String>,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
}

#[tauri::command]
pub fn fav_list(store: State<'_, Arc<Store>>) -> Value {
    serde_json::json!({ "nodes": store.load_favs().nodes })
}

#[tauri::command]
pub fn fav_upsert(store: State<'_, Arc<Store>>, node: FavInput) -> Result<FavNode, String> {
    let mut file = store.load_favs();
    let kind = match node.kind.as_str() {
        "cat" | "fav" => node.kind.clone(),
        other => return Err(format!("未知节点类型: {other}")),
    };
    let title = node.title.trim().to_string();
    if title.is_empty() {
        return Err("标题不能为空".into());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("标题最多 {MAX_TITLE_CHARS} 个字符"));
    }
    // 分类不存正文，避免在树上挂一大段文字后列表读起来很慢
    let body = if kind == "cat" { String::new() } else { node.body.clone() };

    let now = store::now_ms();
    let existing_id = node.id.clone().filter(|s| !s.is_empty());
    let parent = node.parent.clone().filter(|s| !s.is_empty());

    check_place(&file.nodes, existing_id.as_deref(), parent.as_deref(), &kind)?;

    let saved = match existing_id {
        Some(id) => {
            let idx = file
                .nodes
                .iter()
                .position(|n| n.id == id)
                .ok_or_else(|| format!("收藏节点 {id} 不存在"))?;
            let old = file.nodes[idx].clone();
            if old.kind != kind {
                return Err("不能把分类改成条目，或反向修改".into());
            }
            file.nodes[idx] = FavNode {
                id: old.id.clone(),
                parent,
                kind: old.kind.clone(),
                title,
                body,
                created: old.created,
                updated: now,
            };
            file.nodes[idx].clone()
        }
        None => {
            let n = FavNode {
                id: uuid::Uuid::new_v4().simple().to_string(),
                parent,
                kind,
                title,
                body,
                created: now,
                updated: now,
            };
            file.nodes.push(n.clone());
            n
        }
    };
    save(store.inner(), &file.nodes)?;
    Ok(saved)
}

/// 删除分类会连带删掉整棵子树，返回实际删除的节点数
#[tauri::command]
pub fn fav_delete(store: State<'_, Arc<Store>>, id: String) -> Result<usize, String> {
    let mut file = store.load_favs();
    if !file.nodes.iter().any(|n| n.id == id) {
        return Err("要删除的节点不存在".into());
    }
    let doomed = subtree_ids(&file.nodes, &id)?;
    let before = file.nodes.len();
    file.nodes.retain(|n| !doomed.contains(n.id.as_str()));
    save(store.inner(), &file.nodes)?;
    Ok(before - file.nodes.len())
}

#[tauri::command]
pub fn fav_move(store: State<'_, Arc<Store>>, id: String, parent: Option<String>) -> Result<(), String> {
    let mut file = store.load_favs();
    let parent = parent.filter(|s| !s.is_empty());
    let kind = file
        .nodes
        .iter()
        .find(|n| n.id == id)
        .map(|n| n.kind.clone())
        .ok_or_else(|| format!("收藏节点 {id} 不存在"))?;
    check_place(&file.nodes, Some(&id), parent.as_deref(), &kind)?;
    let idx = file
        .nodes
        .iter()
        .position(|n| n.id == id)
        .expect("上面刚确认过存在");
    file.nodes[idx].parent = parent;
    file.nodes[idx].updated = store::now_ms();
    save(store.inner(), &file.nodes)
}

fn save(store: &Store, nodes: &[FavNode]) -> Result<(), String> {
    store.save_favs(&FavFile { nodes: nodes.to_vec() })
}

/// 把节点放到 parent 下面是否合法：父必须是分类、不能形成环、分类不超三级
fn check_place(
    nodes: &[FavNode],
    id: Option<&str>,
    parent: Option<&str>,
    kind: &str,
) -> Result<(), String> {
    if let Some(pid) = parent {
        let p = nodes
            .iter()
            .find(|n| n.id == pid)
            .ok_or_else(|| "上级分类不存在（可能刚被删除）".to_string())?;
        if p.kind != "cat" {
            return Err("收藏条目下面不能再挂东西，请选一个分类".into());
        }
    }
    // 子树里每个分类在新位置上的层级都要 <= MAX_CAT_LEVEL
    let parent_depth = match parent {
        None => 0,
        Some(p) => store::fav_depth(nodes, p),
    };
    let subtree: Vec<(String, usize)> = match id {
        // 新建条目不占分类层数
        None if kind != "cat" => return Ok(()),
        None => vec![(String::new(), 1)],
        Some(i) => {
            if parent == Some(i) {
                return Err("不能把分类移到它自己里面".into());
            }
            cat_levels(nodes, i)?
        }
    };
    for (_cid, rel) in subtree {
        if parent_depth + rel > MAX_CAT_LEVEL {
            return Err(format!("分类最多 {MAX_CAT_LEVEL} 级"));
        }
    }
    Ok(())
}

/// 以 id 为根的子树中所有分类节点及其相对层级（根自身为 1）
fn cat_levels(nodes: &[FavNode], id: &str) -> Result<Vec<(String, usize)>, String> {
    let kids = children_map(nodes);
    let mut out = Vec::new();
    let mut stack: Vec<(String, usize)> = vec![(id.to_string(), 1)];
    let mut seen: HashSet<String> = HashSet::new();
    while let Some((cur, level)) = stack.pop() {
        if !seen.insert(cur.clone()) {
            continue; // 数据被手改出环时不至于死循环
        }
        let node = nodes
            .iter()
            .find(|n| n.id == cur)
            .ok_or_else(|| format!("收藏节点 {cur} 不存在"))?;
        if node.kind == "cat" {
            out.push((node.id.clone(), level));
        }
        for k in kids.get(&cur).into_iter().flatten() {
            stack.push((k.id.clone(), level + 1));
        }
    }
    Ok(out)
}

/// 含自身在内的整棵子树 id（删除用）。条目是叶子，分类会向下递归。
fn subtree_ids(nodes: &[FavNode], id: &str) -> Result<HashSet<String>, String> {
    let kids = children_map(nodes);
    let mut out = HashSet::new();
    let mut stack = vec![id.to_string()];
    while let Some(cur) = stack.pop() {
        if !out.insert(cur.clone()) {
            continue;
        }
        for k in kids.get(&cur).into_iter().flatten() {
            stack.push(k.id.clone());
        }
    }
    Ok(out)
}

fn children_map(nodes: &[FavNode]) -> HashMap<String, Vec<&FavNode>> {
    let mut m: HashMap<String, Vec<&FavNode>> = HashMap::new();
    for n in nodes {
        if let Some(p) = &n.parent {
            m.entry(p.clone()).or_default().push(n);
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, parent: Option<&str>, kind: &str) -> FavNode {
        FavNode {
            id: id.into(),
            parent: parent.map(|s| s.to_string()),
            kind: kind.into(),
            title: format!("节点{id}"),
            body: String::new(),
            created: 0,
            updated: 0,
        }
    }

    #[test]
    fn 第三级分类下禁止再建分类但可挂条目() {
        let nodes = vec![
            node("1", None, "cat"),
            node("2", Some("1"), "cat"),
            node("3", Some("2"), "cat"),
        ];
        // 在 3 下再建分类 -> 第四级，拒绝；挂条目允许
        assert!(check_place(&nodes, None, Some("3"), "cat").is_err());
        assert!(check_place(&nodes, None, Some("3"), "fav").is_ok());
        // 根下建分类是第一级，允许
        assert!(check_place(&nodes, None, None, "cat").is_ok());
        assert!(check_place(&nodes, None, Some("1"), "cat").is_ok());
    }

    #[test]
    fn 条目下不能挂任何东西() {
        let nodes = vec![node("1", None, "cat"), node("f", Some("1"), "fav")];
        assert!(check_place(&nodes, None, Some("f"), "cat").is_err());
        assert!(check_place(&nodes, None, Some("f"), "fav").is_err());
    }

    #[test]
    fn 移动子树按最深层分类判定() {
        // 1 > 2 > 3 三级，把 1 移到 2 下面会成环
        let nodes = vec![
            node("1", None, "cat"),
            node("2", Some("1"), "cat"),
            node("3", Some("2"), "cat"),
            node("x", Some("1"), "fav"),
        ];
        assert!(check_place(&nodes, Some("2"), None, "cat").is_ok()); // 2 变第一级，3 变第二级
        assert!(check_place(&nodes, Some("1"), Some("2"), "cat").is_err()); // 环
        let levels = cat_levels(&nodes, "1").unwrap();
        assert!(levels.iter().any(|(id, l)| id == "3" && *l == 3));
        // 条目不计入分类层级
        assert!(!levels.iter().any(|(id, _)| id == "x"));
        assert_eq!(subtree_ids(&nodes, "1").unwrap().len(), 4);
    }
}
