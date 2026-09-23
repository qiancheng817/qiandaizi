import { Router } from "express";
import { db } from "../db.js";
import { auth, requireBook, wrap } from "../mw.js";

const r = Router();
r.use(auth);

// 归属人显示名：优先取用户表当前昵称，取不到才回落历史文本
const ATTR_EXPR =
  "COALESCE((SELECT u.nickname FROM users u WHERE u.id = flows.attribution_uid), flows.attribution)";

// 时间范围解析：默认当前年
function range(req) {
  const p = { bookId: req.bookId };
  const clause = ["book_id=@bookId"];
  if (req.query.start) { clause.push("flow_time>=@start"); p.start = req.query.start + " 00:00:00"; }
  if (req.query.end) { clause.push("flow_time<=@end"); p.end = req.query.end + " 23:59:59"; }
  return { where: "WHERE " + clause.join(" AND "), p };
}

// 概览：收入、支出、结余、笔数（含按归属人拆分，共享账本用）
r.get(
  "/overview",
  requireBook,
  wrap((req, res) => {
    const { where, p } = range(req);
    const s = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense,
           COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
           COUNT(*) AS count
         FROM flows ${where}`
      )
      .get(p);
    // 按归属人（昵称）拆分的笔数，供「我 / 其他成员」展示
    const byUser = db
      .prepare(
        `SELECT CASE WHEN ${ATTR_EXPR}='' OR ${ATTR_EXPR} IS NULL THEN '未标注' ELSE ${ATTR_EXPR} END AS name,
                COUNT(*) AS count
         FROM flows ${where} GROUP BY name ORDER BY count DESC`
      )
      .all(p);
    // 记账总数（全账本、不限时间），供首页展示「总数」
    const totalCount = db
      .prepare("SELECT COUNT(*) AS n FROM flows WHERE book_id=?")
      .get(req.bookId).n;
    res.json({ ...s, balance: s.income - s.expense, byUser, totalCount });
  })
);

// 钱袋子看板：按归属人汇总「本月 / 本年」收支，外加全员历史总账。
// 首页三张钱袋卡片共用这一个接口；未绑定用户的历史归属也按文本分桶，
// 它们不进个人钱袋，但包含在 total 总账里。
r.get(
  "/moneybags",
  requireBook,
  wrap((req, res) => {
    const now = new Date();
    const month = String(req.query.month ||
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`).slice(0, 7);
    const year = month.slice(0, 4);

    const rows = db
      .prepare(
        `SELECT f.attribution_uid AS uid,
                COALESCE(u.nickname, f.attribution) AS nickname,
                MAX(u.color) AS color,
                COALESCE(SUM(CASE WHEN f.type='income'  AND substr(f.flow_time,1,7)=@m THEN f.amount END),0) AS monthIncome,
                COALESCE(SUM(CASE WHEN f.type='expense' AND substr(f.flow_time,1,7)=@m THEN f.amount END),0) AS monthExpense,
                COALESCE(SUM(CASE WHEN f.type='income'  AND substr(f.flow_time,1,4)=@y THEN f.amount END),0) AS yearIncome,
                COALESCE(SUM(CASE WHEN f.type='expense' AND substr(f.flow_time,1,4)=@y THEN f.amount END),0) AS yearExpense
           FROM flows f LEFT JOIN users u ON u.id = f.attribution_uid
          WHERE f.book_id = @bookId
          GROUP BY f.attribution_uid,
                   CASE WHEN f.attribution_uid IS NULL THEN f.attribution END
          ORDER BY f.attribution_uid`
      )
      .all({ bookId: req.bookId, m: month, y: year });

    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
                COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
           FROM flows WHERE book_id = ?`
      )
      .get(req.bookId);

    res.json({
      month,
      year,
      buckets: rows.map((b) => ({
        uid: b.uid ?? null,
        nickname: b.nickname || "未标注",
        color: b.color || null,
        monthIncome: Number(b.monthIncome),
        monthExpense: Number(b.monthExpense),
        yearIncome: Number(b.yearIncome),
        yearExpense: Number(b.yearExpense),
      })),
      total: {
        income: Number(totals.income),
        expense: Number(totals.expense),
        balance: Number(totals.income) - Number(totals.expense),
      },
    });
  })
);

// 分类饼图（可指定 type=expense|income）
r.get(
  "/category",
  requireBook,
  wrap((req, res) => {
    const { where, p } = range(req);
    p.type = req.query.type === "income" ? "income" : "expense";
    const rows = db
      .prepare(
        `SELECT category AS name, SUM(amount) AS value, COUNT(*) AS count
         FROM flows ${where} AND type=@type
         GROUP BY category ORDER BY value DESC`
      )
      .all(p);
    res.json(rows);
  })
);

// 支付方式饼图
r.get(
  "/payment",
  requireBook,
  wrap((req, res) => {
    const { where, p } = range(req);
    const rows = db
      .prepare(
        `SELECT CASE WHEN payment_method='' THEN '未标注' ELSE payment_method END AS name,
                SUM(amount) AS value
         FROM flows ${where} AND type='expense'
         GROUP BY payment_method ORDER BY value DESC`
      )
      .all(p);
    res.json(rows);
  })
);

// 归属饼图（共享账本谁花的多）
r.get(
  "/attribution",
  requireBook,
  wrap((req, res) => {
    const { where, p } = range(req);
    p.type = req.query.type === "income" ? "income" : "expense";
    // 归属人以「用户表当前昵称」为准，改昵称后统计口径自动同步；
    // 顺带取该用户的颜色，饼图按颜色区分
    const rows = db
      .prepare(
        `SELECT CASE WHEN ${ATTR_EXPR}='' OR ${ATTR_EXPR} IS NULL THEN '未标注' ELSE ${ATTR_EXPR} END AS name,
                SUM(flows.amount) AS value,
                MAX(u.color) AS color
         FROM flows LEFT JOIN users u ON u.id = flows.attribution_uid
         ${where} AND flows.type=@type
         GROUP BY name ORDER BY value DESC`
      )
      .all(p);
    res.json(rows);
  })
);

// 每日流水曲线（含当日 Top3 收/支，供悬浮提示用）
r.get(
  "/daily",
  requireBook,
  wrap((req, res) => {
    const { where, p } = range(req);
    const rows = db
      .prepare(
        `SELECT substr(flow_time,1,10) AS date,
                COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense,
                COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income
         FROM flows ${where}
         GROUP BY date ORDER BY date`
      )
      .all(p);
    // 当日 Top3 收入 / 支出（最多各 3 笔，合计最多 6 笔）
    const top = db
      .prepare(
        `SELECT * FROM (
           SELECT substr(flow_time,1,10) AS date, type, amount, category, description,
                  ROW_NUMBER() OVER (PARTITION BY substr(flow_time,1,10), type ORDER BY amount DESC) AS rn
           FROM flows ${where}
         ) WHERE rn <= 3`
      )
      .all(p);
    const byDate = {};
    for (const t of top) {
      (byDate[t.date] ||= {})[t.type] ||= [];
      byDate[t.date][t.type].push({
        amount: Number(t.amount),
        category: t.category,
        description: t.description,
      });
    }
    res.json(
      rows.map((r) => ({ ...r, top: byDate[r.date] || {} }))
    );
  })
);

// 每月流水柱状（按年）
r.get(
  "/monthly",
  requireBook,
  wrap((req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    // 支持多分类（逗号分隔，如 categories=餐饮,交通）；兼容旧单 category
    const categories = (req.query.categories || "").split(",").map((s) => s.trim()).filter(Boolean);
    const category = (req.query.category || "").trim();
    const useCats = categories.length ? categories : (category ? [category] : []);
    const where = useCats.length
      ? `AND category IN (${useCats.map(() => "?").join(",")})`
      : "";
    const rows = db
      .prepare(
        `SELECT substr(flow_time,1,7) AS month,
                COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense,
                COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income
         FROM flows WHERE book_id=? AND substr(flow_time,1,4)=?
         ${where}
         GROUP BY month ORDER BY month`
      )
      .all(req.bookId, String(year), ...useCats);
    // 补齐 12 个月
    const map = Object.fromEntries(rows.map((x) => [x.month, x]));
    const out = [];
    for (let m = 1; m <= 12; m++) {
      const key = `${year}-${String(m).padStart(2, "0")}`;
      out.push(map[key] || { month: key, expense: 0, income: 0 });
    }
    res.json(out);
  })
);

// 日历看板：某月每天支出/收入
r.get(
  "/calendar",
  requireBook,
  wrap((req, res) => {
    const month = req.query.month; // YYYY-MM
    if (!month) return res.status(400).json({ error: "缺少 month" });
    const rows = db
      .prepare(
        `SELECT substr(flow_time,1,10) AS date,
                COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense,
                COALESCE(SUM(CASE WHEN type='income'  THEN amount END),0) AS income,
                COUNT(*) AS count
         FROM flows WHERE book_id=? AND substr(flow_time,1,7)=?
         GROUP BY date`
      )
      .all(req.bookId, month);
    res.json(rows);
  })
);

// 可用年份 & 归属列表（给筛选器用）
r.get(
  "/facets",
  requireBook,
  wrap((req, res) => {
    const years = db
      .prepare(
        "SELECT DISTINCT substr(flow_time,1,4) AS y FROM flows WHERE book_id=? ORDER BY y DESC"
      )
      .all(req.bookId)
      .map((x) => x.y);
    const months = db
      .prepare(
        "SELECT DISTINCT substr(flow_time,1,7) AS m FROM flows WHERE book_id=? ORDER BY m DESC"
      )
      .all(req.bookId)
      .map((x) => x.m);
    const attributions = db
      .prepare(
        `SELECT DISTINCT ${ATTR_EXPR} AS attribution FROM flows
          WHERE book_id=? AND ${ATTR_EXPR}<>'' ORDER BY attribution`
      )
      .all(req.bookId)
      .map((x) => x.attribution);
    res.json({ years, months, attributions });
  })
);

export default r;
