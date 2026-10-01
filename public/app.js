const passwordInput = document.querySelector("#password");
const messageOutput = document.querySelector("#message");
const loginLink = document.querySelector("#login-link");
const accountList = document.querySelector("#accounts");
const accountCount = document.querySelector("#account-count");
let maxAccounts = 10;
const controls = [
  document.querySelector("#connect"),
  document.querySelector("#run-all"),
  document.querySelector("#refresh"),
];

function showMessage(message, tone = "") {
  messageOutput.textContent = message;
  messageOutput.dataset.tone = tone;
}

function setBusy(busy) {
  const count = accountList.querySelectorAll(".account-card").length;
  for (const control of [...controls, ...accountList.querySelectorAll("button")]) {
    control.disabled = busy
      || (control.id === "run-all" && count === 0)
      || (control.id === "connect" && count >= maxAccounts);
  }
}

async function callAPI(path, method = "GET", payload) {
  const password = passwordInput.value.trim();
  if (!password) throw new Error("请输入管理口令");
  const headers = { Authorization: `Bearer ${password}` };
  const init = { method, headers, cache: "no-store" };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || "请求失败");
  return data;
}

function formatDate(seconds) {
  if (!seconds) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(seconds * 1000));
}

function formatResult(result) {
  switch (result) {
    case "success": return "签到成功";
    case "already": return "今日已签到";
    case "reauth": return "需要重新登录";
    case "failed": return "签到失败";
    case "busy": return "正在运行";
    default: return "暂无记录";
  }
}

function updateStatus(status) {
  const accounts = status.accounts || [];
  maxAccounts = Number(status.maxAccounts) || 10;
  accountCount.textContent = `${accounts.length} / ${maxAccounts}`;
  accountList.replaceChildren();

  if (!accounts.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有连接账号";
    accountList.append(empty);
    return;
  }

  for (const account of accounts) accountList.append(createAccountCard(account));
}

async function refreshStatus() {
  const status = await callAPI("/api/status");
  updateStatus(status);
}

function addMetric(parent, label, value) {
  const metric = document.createElement("div");
  metric.className = "account-metric";
  const title = document.createElement("span");
  title.textContent = label;
  const detail = document.createElement("strong");
  detail.textContent = value;
  metric.append(title, detail);
  parent.append(metric);
}

function createAccountCard(account) {
  const card = document.createElement("article");
  card.className = "account-card";

  const header = document.createElement("div");
  header.className = "account-header";
  const identity = document.createElement("div");
  identity.className = "account-identity";
  const name = document.createElement("h3");
  name.textContent = account.nickname || "WorkBuddy";
  const detail = document.createElement("p");
  detail.textContent = `****${account.uidSuffix || "----"} · ${account.domain || "CodeBuddy CN"}`;
  identity.append(name, detail);

  const remove = document.createElement("button");
  remove.className = "text-button danger";
  remove.type = "button";
  remove.textContent = "移除";
  remove.setAttribute("aria-label", `移除账号 ${account.nickname || "WorkBuddy"}`);
  remove.addEventListener("click", () => void removeAccount(account));
  header.append(identity, remove);

  const metrics = document.createElement("div");
  metrics.className = "account-metrics";
  addMetric(metrics, "最近签到", formatResult(account.result));
  addMetric(metrics, "积分余额", account.balance === null
    ? "暂不可用"
    : new Intl.NumberFormat("zh-CN").format(account.balance));
  addMetric(metrics, "运行时间", formatDate(account.lastRunAt));

  const actions = document.createElement("div");
  actions.className = "account-actions";
  const run = document.createElement("button");
  run.className = "secondary";
  run.type = "button";
  run.textContent = "立即签到";
  run.addEventListener("click", () => void runNow(account.id));
  actions.append(run);

  card.append(header, metrics, actions);
  return card;
}

async function runNow(accountId = null) {
  setBusy(true);
  showMessage(accountId ? "正在签到…" : "正在逐个签到…");
  try {
    const result = await callAPI("/api/run", "POST", accountId ? { accountId } : {});
    showMessage(result.message, result.result === "success" || result.result === "already" ? "success" : "");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    await refreshStatus().catch((error) => showMessage(error.message, "error"));
    setBusy(false);
  }
}

async function removeAccount(account) {
  if (!window.confirm(`移除账号“${account.nickname || "WorkBuddy"}”？`)) return;
  setBusy(true);
  try {
    await callAPI(`/api/accounts/${encodeURIComponent(account.id)}`, "DELETE");
    await refreshStatus();
    showMessage("账号已移除", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(false);
  }
}

async function pollLogin(id) {
  setBusy(true);
  showMessage("等待官方登录确认…");
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const result = await callAPI("/api/login/poll", "POST", { id });
      if (result.status === "connected") {
        loginLink.hidden = true;
        await refreshStatus();
        showMessage("账号已添加，正在验证首次签到…", "success");
        setBusy(false);
        await runNow(result.accountId);
        return;
      }
    }
    loginLink.hidden = true;
    showMessage("登录等待超时，请重新连接账号", "error");
  } catch (error) {
    loginLink.hidden = true;
    showMessage(error.message, "error");
  } finally {
    setBusy(false);
  }
}

document.querySelector("#connect").addEventListener("click", async () => {
  setBusy(true);
  loginLink.hidden = true;
  showMessage("正在连接 WorkBuddy…");
  try {
    const result = await callAPI("/api/login/start", "POST", {});
    loginLink.href = result.authUrl;
    loginLink.hidden = false;
    loginLink.onclick = () => void pollLogin(result.id);
    showMessage("打开官方登录页并完成授权，然后回到这里等待连接。 ");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(false);
  }
});

document.querySelector("#run-all").addEventListener("click", () => void runNow());
document.querySelector("#refresh").addEventListener("click", async () => {
  setBusy(true);
  try {
    await refreshStatus();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(false);
  }
});
