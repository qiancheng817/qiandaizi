<script setup>
import { ref, onMounted, computed } from "vue";
import dayjs from "dayjs";
import api from "../api.js";
import { useStore } from "../store.js";
import FlowDialog from "../components/FlowDialog.vue";

const store = useStore();
const month = ref(dayjs().format("YYYY-MM"));
// 钱袋子看板数据（按归属人分桶 + 全员总账）
const bags = ref({ buckets: [], total: { income: 0, expense: 0, balance: 0 }, year: String(dayjs().year()) });
const calendar = ref({});
const recent = ref([]);
// 账本成员（用于确定「对方」，/flows/attributions 返回 id+昵称）
const members = ref([]);
// 最近记录筛选：all 默认；me=我的；other=对方
const recentFilter = ref("all");
// 消费日历默认收起，点总钱袋里的按钮才展开
const calendarOpen = ref(false);
const loadingRecent = ref(false);
const showDialog = ref(false);
const preset = ref(null);

const monthStart = computed(() => month.value + "-01");
const monthEnd = computed(() => dayjs(monthStart.value).endOf("month").format("YYYY-MM-DD"));

// 对方成员：账本里除我之外的第一个成员
const otherMember = computed(() => members.value.find((m) => m.id !== store.user?.id) || null);

// 看的是本月还是历史月份（翻日历时卡片标题同步变化，避免误导）
const isCurrentMonth = computed(() => month.value === dayjs().format("YYYY-MM"));
const periodLabel = computed(() => (isCurrentMonth.value ? "本月" : dayjs(monthStart.value).format("MM月")));

// 把分桶数据整理成卡片需要的结构；没有分桶（本月/本年没记录）就补零
function bagOf(b, fallbackName, fallbackColor) {
  const monthIncome = b?.monthIncome || 0;
  const monthExpense = b?.monthExpense || 0;
  const yearIncome = b?.yearIncome || 0;
  const yearExpense = b?.yearExpense || 0;
  return {
    name: b?.nickname || fallbackName || "",
    color: b?.color || fallbackColor || null,
    monthIncome,
    monthExpense,
    monthBalance: monthIncome - monthExpense,
    yearIncome,
    yearExpense,
    yearBalance: yearIncome - yearExpense,
  };
}

// 我的钱袋：归属 uid 等于当前登录账号
const meBag = computed(() => {
  const b = bags.value.buckets.find((x) => x.uid === store.user?.id);
  return bagOf(b, store.user?.nickname, store.user?.color);
});
// 对方的钱袋：归属 uid 是另一个成员
const otherBag = computed(() => {
  const o = otherMember.value;
  const b = bags.value.buckets.find((x) => x.uid && x.uid !== store.user?.id);
  return bagOf(b, o?.nickname, null);
});

async function loadStats() {
  const [mb, cal, attr] = await Promise.all([
    api.get("/stats/moneybags", { params: { month: month.value } }),
    api.get("/stats/calendar", { params: { month: month.value } }),
    members.value.length ? Promise.resolve(null) : api.get("/flows/attributions"),
  ]);
  bags.value = mb.data;
  calendar.value = Object.fromEntries(cal.data.map((d) => [d.date, d]));
  if (attr) members.value = attr.data.members;
}

async function loadRecent() {
  loadingRecent.value = true;
  try {
    const params = { start: monthStart.value, end: monthEnd.value, pageSize: 8 };
    if (recentFilter.value === "me") params.attributionUid = store.user.id;
    else if (recentFilter.value === "other" && otherMember.value) params.attributionUid = otherMember.value.id;
    const { data } = await api.get("/flows", { params });
    recent.value = data.list;
  } finally {
    loadingRecent.value = false;
  }
}

function load() {
  return Promise.all([loadStats(), loadRecent()]);
}
onMounted(load);

// 日历渲染
const days = computed(() => {
  const first = dayjs(monthStart.value);
  const start = first.day(); // 周日=0
  const total = first.daysInMonth();
  const arr = [];
  for (let i = 0; i < start; i++) arr.push(null);
  for (let d = 1; d <= total; d++) {
    const date = first.date(d).format("YYYY-MM-DD");
    arr.push({ d, date, ...(calendar.value[date] || {}) });
  }
  return arr;
});
const maxExpense = computed(() =>
  Math.max(1, ...Object.values(calendar.value).map((x) => x.expense || 0))
);
function heat(day) {
  if (!day?.expense) return 0;
  return Math.min(1, day.expense / maxExpense.value);
}

function changeMonth(delta) {
  month.value = dayjs(monthStart.value).add(delta, "month").format("YYYY-MM");
  load();
}

// 展开/收起消费日历
function toggleCalendar() {
  calendarOpen.value = !calendarOpen.value;
}

// 切换最近记录归属
function switchFilter(k) {
  if (recentFilter.value === k) return;
  recentFilter.value = k;
  loadRecent();
}

function quickAddOn(date) {
  preset.value = { flow_time: dayjs(date).format("YYYY-MM-DD") };
  showDialog.value = true;
}
function onSaved() {
  load();
}
function fmt(n) {
  return "¥" + Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function catIcon(name) {
  return store.categories.find((c) => c.name === name)?.icon || "💰";
}
function initialOf(name) {
  return (name || "?").trim()[0] || "?";
}
</script>

<template>
  <div>
    <div class="head-row">
      <h2 class="page-title" style="margin:0">你好，{{ store.user?.nickname }} 👋</h2>
      <button class="btn btn-primary" @click="preset=null; showDialog=true">＋ 记一笔</button>
    </div>

    <!-- 第一行：我的钱袋 / 对方的钱袋（等宽） -->
    <div class="grid bags-row" :class="{ solo: !otherMember }">
      <div class="card bag-card">
        <div class="bag-head">
          <span class="avatar" :style="{ background: meBag.color || 'var(--primary)' }">{{ initialOf(meBag.name) }}</span>
          <b class="bag-title">我的钱袋</b>
        </div>
        <div class="bag-grid">
          <div class="bi">
            <div class="muted bl">{{ periodLabel }}收入</div>
            <div class="bv income">{{ fmt(meBag.monthIncome) }}</div>
          </div>
          <div class="bi">
            <div class="muted bl">{{ periodLabel }}支出</div>
            <div class="bv expense">{{ fmt(meBag.monthExpense) }}</div>
          </div>
          <div class="bi">
            <div class="muted bl">{{ periodLabel }}结余</div>
            <div class="bv" :class="meBag.monthBalance >= 0 ? 'income' : 'expense'">{{ fmt(meBag.monthBalance) }}</div>
          </div>
          <div class="bi">
            <div class="muted bl">{{ bags.year }}年结余</div>
            <div class="bv" :class="meBag.yearBalance >= 0 ? 'income' : 'expense'">{{ fmt(meBag.yearBalance) }}</div>
          </div>
        </div>
      </div>

      <div class="card bag-card" v-if="otherMember">
        <div class="bag-head">
          <span class="avatar" :style="{ background: otherBag.color || 'var(--text-2)' }">{{ initialOf(otherBag.name) }}</span>
          <b class="bag-title">对方的钱袋</b>
        </div>
        <div class="bag-grid">
          <div class="bi">
            <div class="muted bl">{{ periodLabel }}收入</div>
            <div class="bv income">{{ fmt(otherBag.monthIncome) }}</div>
          </div>
          <div class="bi">
            <div class="muted bl">{{ periodLabel }}支出</div>
            <div class="bv expense">{{ fmt(otherBag.monthExpense) }}</div>
          </div>
          <div class="bi">
            <div class="muted bl">{{ periodLabel }}结余</div>
            <div class="bv" :class="otherBag.monthBalance >= 0 ? 'income' : 'expense'">{{ fmt(otherBag.monthBalance) }}</div>
          </div>
          <div class="bi">
            <div class="muted bl">{{ bags.year }}年结余</div>
            <div class="bv" :class="otherBag.yearBalance >= 0 ? 'income' : 'expense'">{{ fmt(otherBag.yearBalance) }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 第二行：总钱袋（宽度与上面一行对齐） -->
    <div class="card total-card">
      <div class="cal-head">
        <b class="section-title" style="margin:0">🏆 总钱袋</b>
        <button class="btn btn-sm cal-btn" :class="{ on: calendarOpen }" @click="toggleCalendar">
          📅 消费日历<span class="caret">{{ calendarOpen ? "▾" : "▸" }}</span>
        </button>
      </div>
      <div class="grid total-grid">
        <div>
          <div class="muted bl">总收入</div>
          <div class="tv income">{{ fmt(bags.total.income) }}</div>
        </div>
        <div>
          <div class="muted bl">总支出</div>
          <div class="tv expense">{{ fmt(bags.total.expense) }}</div>
        </div>
        <div>
          <div class="muted bl">总结余</div>
          <div class="tv" :class="bags.total.balance >= 0 ? 'income' : 'expense'">{{ fmt(bags.total.balance) }}</div>
        </div>
      </div>

      <!-- 消费日历：点击按钮才展开 -->
      <div v-if="calendarOpen" class="calendar-wrap">
        <div class="cal-head">
          <span class="muted"></span>
          <div class="row" style="align-items:center;gap:8px">
            <button class="btn btn-sm" @click="changeMonth(-1)">‹</button>
            <b>{{ month }}</b>
            <button class="btn btn-sm" @click="changeMonth(1)">›</button>
          </div>
        </div>
        <div class="week">
          <span v-for="w in ['日','一','二','三','四','五','六']" :key="w">{{ w }}</span>
        </div>
        <div class="cal">
          <div v-for="(day, i) in days" :key="i" class="cell" :class="{ empty: !day }" @click="day && quickAddOn(day.date)">
            <template v-if="day">
              <span class="dnum" :style="{ background: day.expense ? `rgba(239,68,68,${0.12 + heat(day)*0.5})` : 'transparent' }">{{ day.d }}</span>
              <span v-if="day.expense" class="ce expense">-{{ Number(day.expense).toFixed(0) }}</span>
              <span v-if="day.income" class="ci income">+{{ Number(day.income).toFixed(0) }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- 最近记录：我的 / 对方 / 所有 切换，默认所有 -->
    <div class="card recent-card">
      <div class="cal-head recent-head">
        <b class="section-title" style="margin:0">最近记录</b>
        <div class="row" style="align-items:center;gap:10px">
          <div class="seg">
            <button class="seg-btn" :class="{ on: recentFilter === 'me' }" @click="switchFilter('me')">我的</button>
            <button v-if="otherMember" class="seg-btn" :class="{ on: recentFilter === 'other' }" @click="switchFilter('other')">对方</button>
            <button class="seg-btn" :class="{ on: recentFilter === 'all' }" @click="switchFilter('all')">所有</button>
          </div>
          <router-link class="muted all-link" to="/flows">查看全部 ›</router-link>
        </div>
      </div>
      <div v-if="loadingRecent" class="empty-tip muted">加载中…</div>
      <div v-else-if="!recent.length" class="empty-tip muted">{{ periodLabel }}还没有相关记录，点右上角「记一笔」开始吧</div>
      <template v-else>
        <div v-for="f in recent" :key="f.id" class="frow">
          <div class="ficon">{{ catIcon(f.category) }}</div>
          <div class="fmain">
            <div class="fcat">
              <span v-if="f.source === 'ai'" class="ai-tag" title="AI 记账">AI</span>
              {{ f.category }}<span v-if="f.description" class="muted"> · {{ f.description }}</span>
            </div>
            <div class="muted ftime">{{ dayjs(f.flow_time).format("MM-DD") }} · {{ f.attribution || "—" }}</div>
          </div>
          <div class="famt" :class="f.type">{{ f.type === "expense" ? "-" : "+" }}{{ Number(f.amount).toFixed(2) }}</div>
        </div>
      </template>
    </div>

    <FlowDialog v-model="showDialog" :preset="preset" @saved="onSaved" />
  </div>
</template>

<style scoped>
.ai-tag {
  display: inline-block;
  margin-right: 6px;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 11px;
  font-weight: 600;
  line-height: 17px;
  vertical-align: 1px;
}
.head-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }

/* 第一行：两个等宽钱袋卡片；单人账本只有一张时占满整行 */
.bags-row { grid-template-columns: 1fr; }
.bags-row.solo .bag-card { grid-column: 1 / -1; }
@media (min-width: 721px) {
  .bags-row { grid-template-columns: 1fr 1fr; }
}

.bag-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.avatar {
  width: 34px; height: 34px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  color: #fff; font-size: 15px; font-weight: 700;
}
.bag-title { font-size: 15px; font-weight: 700; }
.bag-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 12px; }
.bl { font-size: 13px; }
.bv { font-size: 18px; font-weight: 800; margin-top: 3px; }

/* 第二行：总钱袋 */
.total-card { margin-top: 16px; }
.cal-btn .caret { margin-left: 4px; font-size: 11px; }
.cal-btn.on { border-color: var(--primary); color: var(--primary); }
.total-grid { grid-template-columns: repeat(3, 1fr); }
.tv { font-size: 22px; font-weight: 800; margin-top: 4px; }

/* 展开的消费日历 */
.calendar-wrap { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
.cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.week { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; color: var(--text-2); font-size: 13px; margin-bottom: 6px; }
.cal { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.cell { min-height: 68px; border-radius: 8px; padding: 5px; cursor: pointer; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.cell:hover:not(.empty) { background: var(--surface-2); }
.cell.empty { cursor: default; }
.dnum { font-size: 14px; font-weight: 600; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; color: var(--text); }
.ce, .ci { font-size: 13px; line-height: 1.25; font-weight: 600; }

/* 最近记录 */
.recent-card { margin-top: 16px; }
.recent-head { gap: 10px; flex-wrap: wrap; }
.seg { display: inline-flex; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 3px; }
.seg-btn { border: 0; background: transparent; color: var(--text-2); padding: 6px 14px; font-size: 13px; border-radius: 8px; cursor: pointer; }
.seg-btn.on { background: var(--surface); color: var(--primary); font-weight: 600; box-shadow: var(--shadow); }
.all-link { font-size: 13px; white-space: nowrap; }

.famt { font-weight: 700; }
.frow { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid var(--border); }
.frow:first-of-type { border-top: none; }
.ficon { width: 38px; height: 38px; border-radius: 10px; background: var(--surface-2); display: flex; align-items: center; justify-content: center; font-size: 19px; }
.fmain { flex: 1; min-width: 0; }
.fcat { font-size: 14px; }
.ftime { font-size: 12px; margin-top: 2px; }
.empty-tip { text-align: center; padding: 30px 0; }

@media (max-width: 720px) {
  .bv { font-size: 16px; }
  .tv { font-size: 19px; }
  .total-grid { grid-template-columns: 1fr; gap: 10px; }
  /* 窄屏 7 列更挤：日期/金额降一档 */
  .cell { min-height: 62px; padding: 4px; }
  .dnum { font-size: 13px; width: 23px; height: 23px; }
  .ce, .ci { font-size: 11.5px; }
}
</style>
