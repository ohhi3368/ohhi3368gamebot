const tokenInput = document.getElementById("token");
const saveTokenBtn = document.getElementById("saveToken");
const currencySymbolInput = document.getElementById("currencySymbol");
const updateIntervalInput = document.getElementById("updateIntervalSec");
const safeZonePercentInput = document.getElementById("safeZonePercent");
const redLinePercentInput = document.getElementById("redLinePercent");
const moneyUnitDivisorInput = document.getElementById("moneyUnitDivisor");
const moneyDisplayUnitValueInput = document.getElementById("moneyDisplayUnitValue");
const moneyDisplayUnitLabelInput = document.getElementById("moneyDisplayUnitLabel");
const addMoneyUnitBtn = document.getElementById("addMoneyUnit");
const moneyUnitListEl = document.getElementById("moneyUnitList");
const saveSettingsBtn = document.getElementById("saveSettings");
const stockNameInput = document.getElementById("stockName");
const stockBasePriceInput = document.getElementById("stockBasePrice");
const stockVolatilityInput = document.getElementById("stockVolatility");
const stockColorInput = document.getElementById("stockColor");
const addStockBtn = document.getElementById("addStock");
const stockListEl = document.getElementById("stockList");
const statusEl = document.getElementById("status");
const tabAdminBtn = document.getElementById("tabAdmin");
const tabGraphBtn = document.getElementById("tabGraph");
const viewAdminEl = document.getElementById("viewAdmin");
const viewGraphEl = document.getElementById("viewGraph");
const graphModeEl = document.getElementById("graphMode");
const graphStockEl = document.getElementById("graphStock");
const refreshGraphBtn = document.getElementById("refreshGraph");
const graphCanvas = document.getElementById("graphCanvas");
const graphLegendEl = document.getElementById("graphLegend");
const graphCtx = graphCanvas.getContext("2d");
const depressionOnBtn = document.getElementById("depressionOn");
const depressionOffBtn = document.getElementById("depressionOff");
const depressionStateEl = document.getElementById("depressionState");
const themeToggleBtn = document.getElementById("themeToggle");
const stockEditModalEl = document.getElementById("stockEditModal");
const editBasePriceInput = document.getElementById("editBasePrice");
const editCurrentPriceInput = document.getElementById("editCurrentPrice");
const editVolatilityInput = document.getElementById("editVolatility");
const saveStockEditBtn = document.getElementById("saveStockEdit");
const cancelStockEditBtn = document.getElementById("cancelStockEdit");
const leaderboardBodyEl = document.getElementById("leaderboardBody");
const eventTitleInput = document.getElementById("eventTitle");
const eventPriceInput = document.getElementById("eventPrice");
const eventMultiplierInput = document.getElementById("eventMultiplier");
const createEventBtn = document.getElementById("createEvent");
const eventListEl = document.getElementById("eventList");

const storageKey = "stock-admin-token";
const themeStorageKey = "stock-dashboard-theme";
tokenInput.value = localStorage.getItem(storageKey) || "";
let latestStocks = [];
let latestCurrency = "$";
let latestSettings = {};
let latestEvents = [];
let autoRefreshTimer = null;
let moneyDisplayUnits = defaultDisplayUnits();
let settingsDirty = false;
let editingStockId = null;

tabAdminBtn.addEventListener("click", () => setTab("admin"));
tabGraphBtn.addEventListener("click", () => setTab("graph"));
graphModeEl.addEventListener("change", () => {
  toggleGraphStockSelector();
  renderGraph();
});
graphStockEl.addEventListener("change", () => renderGraph());
refreshGraphBtn.addEventListener("click", () => renderGraph());
[
  currencySymbolInput,
  updateIntervalInput,
  safeZonePercentInput,
  redLinePercentInput,
  moneyUnitDivisorInput,
  moneyDisplayUnitValueInput,
  moneyDisplayUnitLabelInput,
].forEach((el) => {
  el.addEventListener("input", () => {
    settingsDirty = true;
  });
});
addMoneyUnitBtn.addEventListener("click", () => {
  const value = Math.floor(Number(moneyDisplayUnitValueInput.value));
  const label = String(moneyDisplayUnitLabelInput.value || "").trim().slice(0, 8);
  if (!Number.isFinite(value) || value < 1 || !label) {
    setStatus("단위 값/라벨을 올바르게 입력하세요.");
    return;
  }
  const exists = moneyDisplayUnits.some((u) => u.value === value && u.label === label);
  if (!exists) moneyDisplayUnits.push({ value, label });
  moneyDisplayUnits = normalizeDisplayUnits(moneyDisplayUnits);
  renderMoneyUnitList();
  settingsDirty = true;
});
themeToggleBtn.addEventListener("click", () => {
  const isDark = document.body.classList.toggle("dark");
  localStorage.setItem(themeStorageKey, isDark ? "dark" : "light");
  updateThemeToggleLabel(isDark);
});
depressionOnBtn.addEventListener("click", async () => {
  const out = await api("/api/market/depression/on", { method: "POST" });
  if (out.ok) {
    setStatus("대공황 시작");
    refresh();
  } else {
    setStatus(`대공황 시작 실패: ${out.error || "unknown error"}`);
  }
});
depressionOffBtn.addEventListener("click", async () => {
  const out = await api("/api/market/depression/off", { method: "POST" });
  if (out.ok) {
    setStatus("대공황 해제");
    refresh();
  } else {
    setStatus(`대공황 해제 실패: ${out.error || "unknown error"}`);
  }
});

saveTokenBtn.addEventListener("click", () => {
  localStorage.setItem(storageKey, tokenInput.value.trim());
  setStatus("Token saved");
  refresh();
});

createEventBtn.addEventListener("click", async () => {
  const payload = {
    title: eventTitleInput.value.trim(),
    price: Number(eventPriceInput.value),
    successMultiplier: Number(eventMultiplierInput.value),
  };
  const out = await api("/api/events", { method: "POST", body: JSON.stringify(payload) });
  if (out.ok) {
    eventTitleInput.value = "";
    eventPriceInput.value = "";
    eventMultiplierInput.value = "3";
    setStatus("이벤트 생성 완료");
    refresh({ forceSettingsSync: true });
  } else {
    setStatus(`이벤트 생성 실패: ${out.error || "unknown error"}`);
  }
});

saveStockEditBtn.addEventListener("click", async () => {
  if (!editingStockId) return;
  const payload = {
    basePrice: Number(editBasePriceInput.value),
    currentPrice: Number(editCurrentPriceInput.value),
    baseVolatility: Number(editVolatilityInput.value),
  };
  const out = await api(`/api/stocks/${editingStockId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  if (out.ok) {
    closeStockEditModal();
    setStatus("주식 정보 수정 완료");
    refresh({ forceSettingsSync: true });
  } else {
    setStatus(`주식 수정 실패: ${out.error || "unknown error"}`);
  }
});

cancelStockEditBtn.addEventListener("click", () => {
  closeStockEditModal();
});

saveSettingsBtn.addEventListener("click", async () => {
  const payload = {
    currencySymbol: currencySymbolInput.value.trim(),
    updateIntervalSec: Number(updateIntervalInput.value),
    safeZonePercent: Number(safeZonePercentInput.value),
    redLinePercent: Number(redLinePercentInput.value),
    moneyUnitDivisor: Number(moneyUnitDivisorInput.value),
    moneyDisplayUnitValue: Number(moneyDisplayUnitValueInput.value),
    moneyDisplayUnitLabel: moneyDisplayUnitLabelInput.value.trim(),
    moneyDisplayUnits,
  };
  const res = await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    settingsDirty = false;
    setStatus("Settings saved");
    refresh({ forceSettingsSync: true });
  } else {
    setStatus(`Settings failed: ${res.error || "unknown error"}`);
  }
});

addStockBtn.addEventListener("click", async () => {
  const payload = {
    name: stockNameInput.value.trim(),
    basePrice: Number(stockBasePriceInput.value),
    volatility: Number(stockVolatilityInput.value),
    color: stockColorInput.value.trim(),
  };
  const res = await api("/api/stocks", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    stockNameInput.value = "";
    stockBasePriceInput.value = "";
    stockVolatilityInput.value = "";
    stockColorInput.value = "#32a852";
    setStatus("Stock added");
    refresh();
  } else {
    setStatus(`Add failed: ${res.error || "unknown error"}`);
  }
});

async function refresh(options = {}) {
  const forceSettingsSync = Boolean(options.forceSettingsSync);
  const res = await api("/api/state");
  if (!res.ok) {
    setStatus(`Load failed: ${res.error || "unknown error"}`);
    return;
  }
  const { settings, stocks } = res.data;
  latestSettings = settings || {};
  latestStocks = Array.isArray(stocks) ? stocks : [];
  latestEvents = Array.isArray(res.data.events) ? res.data.events : [];
  latestCurrency = settings.currencySymbol || "$";
  if (forceSettingsSync || !settingsDirty) {
    currencySymbolInput.value = settings.currencySymbol;
    updateIntervalInput.value = settings.updateIntervalSec;
    safeZonePercentInput.value = Number(settings.safeZonePercent ?? 100);
    redLinePercentInput.value = Number(settings.redLinePercent ?? 300);
    moneyUnitDivisorInput.value = Number(settings.moneyUnitDivisor ?? 1);
    moneyDisplayUnitValueInput.value = Number(settings.moneyDisplayUnitValue ?? 10000);
    moneyDisplayUnitLabelInput.value = String(settings.moneyDisplayUnitLabel ?? "만");
    moneyDisplayUnits = normalizeDisplayUnits(
      settings.moneyDisplayUnits ??
        [
          {
            value: settings.moneyDisplayUnitValue ?? 10000,
            label: settings.moneyDisplayUnitLabel ?? "만",
          },
        ]
    );
    renderMoneyUnitList();
  }
  depressionStateEl.textContent = `상태: ${settings.depressionMode ? "대공황 진행중" : "정상"}`;
  renderStocks(stocks, settings.currencySymbol);
  renderEvents(latestEvents);
  await refreshLeaderboard();
  populateGraphStockOptions(stocks);
  renderGraph();
  configureAutoRefresh(settings.updateIntervalSec);
}

function renderStocks(stocks, symbol) {
  stockListEl.innerHTML = "";
  if (!stocks.length) {
    stockListEl.textContent = "No stocks yet.";
    return;
  }

  for (const stock of stocks) {
    const row = document.createElement("div");
    const trendClass = stock.trend === "up" ? "trend-up" : stock.trend === "down" ? "trend-down" : "trend-neutral";
    row.className = `stock-item ${trendClass}`;

    const left = document.createElement("div");
    left.innerHTML = `
      <strong>${escapeHtml(stock.name)}</strong>
      <span class="chip ${stock.delisted ? "delisted" : "active"}">
        ${stock.delisted ? "상장폐지 상태" : "상장 상태"}
      </span>
      <span class="trend-chip ${trendClass}">${trendLabel(stock.trend, stock.trendControl)}</span>
      <div>Base: ${escapeHtml(formatDisplayMoney(stock.basePrice))} ${escapeHtml(symbol)}</div>
      <div>Current: ${escapeHtml(formatDisplayMoney(stock.currentPrice))} ${escapeHtml(symbol)}</div>
      <div>Volatility: ${Number(stock.baseVolatility).toFixed(2)}%</div>
    `;

    const colorRow = document.createElement("div");
    colorRow.className = "color-row";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = stock.color || "#32a852";
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = stock.color || "#32a852";
    colorInput.className = "color-input";
    const saveColorBtn = document.createElement("button");
    saveColorBtn.textContent = "Save Color";
    saveColorBtn.onclick = async () => {
      const out = await api(`/api/stocks/${stock.id}/color`, {
        method: "PATCH",
        body: JSON.stringify({ color: colorInput.value.trim() }),
      });
      if (out.ok) {
        setStatus(`${stock.name} color saved`);
        refresh();
      } else {
        setStatus(`Color update failed: ${out.error || "unknown error"}`);
      }
    };

    colorRow.appendChild(swatch);
    colorRow.appendChild(colorInput);
    colorRow.appendChild(saveColorBtn);
    left.appendChild(colorRow);

    const actions = document.createElement("div");
    actions.className = "stock-actions";

    const editBtn = document.createElement("button");
    editBtn.textContent = "✏️";
    editBtn.className = "edit-btn";
    editBtn.title = "주식 수정";
    editBtn.onclick = () => openStockEditModal(stock);
    actions.appendChild(editBtn);

    const upBtn = document.createElement("button");
    upBtn.textContent = "상승";
    upBtn.className = "ok";
    upBtn.onclick = async () => {
      const out = await api(`/api/stocks/${stock.id}/trend`, {
        method: "PATCH",
        body: JSON.stringify({ trend: "up" }),
      });
      if (out.ok) {
        setStatus(`${stock.name} trend: 상승`);
        refresh();
      } else {
        setStatus(`Trend update failed: ${out.error || "unknown error"}`);
      }
    };
    actions.appendChild(upBtn);

    const downBtn = document.createElement("button");
    downBtn.textContent = "하락";
    downBtn.className = "danger";
    downBtn.onclick = async () => {
      const out = await api(`/api/stocks/${stock.id}/trend`, {
        method: "PATCH",
        body: JSON.stringify({ trend: "down" }),
      });
      if (out.ok) {
        setStatus(`${stock.name} trend: 하락`);
        refresh();
      } else {
        setStatus(`Trend update failed: ${out.error || "unknown error"}`);
      }
    };
    actions.appendChild(downBtn);

    const neutralBtn = document.createElement("button");
    neutralBtn.textContent = "표준";
    neutralBtn.onclick = async () => {
      const out = await api(`/api/stocks/${stock.id}/trend`, {
        method: "PATCH",
        body: JSON.stringify({ trend: "neutral" }),
      });
      if (out.ok) {
        setStatus(`${stock.name} trend: 표준`);
        refresh();
      } else {
        setStatus(`Trend update failed: ${out.error || "unknown error"}`);
      }
    };
    actions.appendChild(neutralBtn);

    if (!stock.delisted) {
      const delistBtn = document.createElement("button");
      delistBtn.textContent = "Delist";
      delistBtn.className = "danger";
      delistBtn.onclick = async () => {
        const out = await api(`/api/stocks/${stock.id}/delist`, { method: "POST" });
        if (out.ok) {
          setStatus(`${stock.name} delisted`);
          refresh();
        } else {
          setStatus(`Delist failed: ${out.error || "unknown error"}`);
        }
      };
      actions.appendChild(delistBtn);
    } else {
      const relistBtn = document.createElement("button");
      relistBtn.textContent = "Relist";
      relistBtn.className = "ok";
      relistBtn.onclick = async () => {
        const out = await api(`/api/stocks/${stock.id}/relist`, { method: "POST" });
        if (out.ok) {
          setStatus(`${stock.name} relisted`);
          refresh();
        } else {
          setStatus(`Relist failed: ${out.error || "unknown error"}`);
        }
      };
      actions.appendChild(relistBtn);
    }

    row.appendChild(left);
    row.appendChild(actions);
    stockListEl.appendChild(row);
  }
}

async function api(path, options = {}) {
  const token = tokenInput.value.trim();
  try {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": token,
        ...(options.headers || {}),
      },
    });
    let json = {};
    try {
      json = await response.json();
    } catch {}
    if (!response.ok) {
      return { ok: false, error: json.error || `${response.status}` };
    }
    return { ok: true, data: json };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(message) {
  statusEl.textContent = message;
}

function configureAutoRefresh(intervalSec) {
  const ms = Math.max(0, Number(intervalSec || 60)) * 1000;
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    refresh();
  }, ms);
}

function setTab(tab) {
  const isAdmin = tab === "admin";
  viewAdminEl.classList.toggle("hidden", !isAdmin);
  viewGraphEl.classList.toggle("hidden", isAdmin);
  tabAdminBtn.classList.toggle("active", isAdmin);
  tabGraphBtn.classList.toggle("active", !isAdmin);
}

function toggleGraphStockSelector() {
  graphStockEl.disabled = graphModeEl.value !== "single";
}

function populateGraphStockOptions(stocks) {
  const previous = graphStockEl.value;
  graphStockEl.innerHTML = "";
  const active = stocks.filter((s) => !s.delisted);
  for (const stock of active) {
    const option = document.createElement("option");
    option.value = stock.id;
    option.textContent = stock.name;
    graphStockEl.appendChild(option);
  }
  if (previous && active.some((s) => s.id === previous)) {
    graphStockEl.value = previous;
  }
  toggleGraphStockSelector();
}

function renderGraph() {
  const width = graphCanvas.width;
  const height = graphCanvas.height;
  graphCtx.clearRect(0, 0, width, height);
  graphCtx.fillStyle = "#0f1724";
  graphCtx.fillRect(0, 0, width, height);

  const left = 70;
  const right = 25;
  const top = 20;
  const bottom = 45;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const active = latestStocks.filter((s) => !s.delisted);
  let selected = active;
  if (graphModeEl.value === "single") {
    selected = active.filter((s) => s.id === graphStockEl.value);
  }
  if (!selected.length) {
    graphCtx.fillStyle = "#d5e2f6";
    graphCtx.font = "20px Segoe UI";
    graphCtx.fillText("그래프를 표시할 주식이 없습니다.", left, top + 30);
    graphLegendEl.innerHTML = "";
    return;
  }

  const series = selected.map((stock) => ({
    stock,
    points: (Array.isArray(stock.history) ? stock.history : []).slice(-30),
    color: stock.color || "#32a852",
  }));
  const validSeries = series.filter((s) => s.points.length > 0);
  if (!validSeries.length) return;

  const values = validSeries.flatMap((s) => s.points.map((p) => Number(p.p)));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.1, 1);
  const yMin = min - pad;
  const yMax = max + pad;

  graphCtx.strokeStyle = "#32445f";
  graphCtx.lineWidth = 1;
  for (let i = 0; i <= 6; i += 1) {
    const y = top + (plotH * i) / 6;
    graphCtx.beginPath();
    graphCtx.moveTo(left, y);
    graphCtx.lineTo(left + plotW, y);
    graphCtx.stroke();

    const value = yMax - ((y - top) / plotH) * (yMax - yMin);
    graphCtx.fillStyle = "#9db4d5";
    graphCtx.font = "12px Segoe UI";
    graphCtx.fillText(value.toFixed(2), 8, y + 4);
  }

  for (const s of validSeries) {
    const n = s.points.length;
    graphCtx.strokeStyle = s.color;
    graphCtx.lineWidth = 2;
    graphCtx.beginPath();
    for (let i = 0; i < n; i += 1) {
      const x = left + (i / Math.max(n - 1, 1)) * plotW;
      const y = top + ((yMax - s.points[i].p) / Math.max(yMax - yMin, 0.0001)) * plotH;
      if (i === 0) graphCtx.moveTo(x, y);
      else graphCtx.lineTo(x, y);
    }
    graphCtx.stroke();

    const last = s.points[n - 1];
    const lx = left + plotW;
    const ly = top + ((yMax - last.p) / Math.max(yMax - yMin, 0.0001)) * plotH;
    graphCtx.fillStyle = "#ffffff";
    graphCtx.beginPath();
    graphCtx.arc(lx, ly, 4, 0, Math.PI * 2);
    graphCtx.fill();
    graphCtx.fillStyle = s.color;
    graphCtx.font = "12px Segoe UI";
    graphCtx.fillText(`${formatDisplayMoney(last.p)} ${latestCurrency}`, lx + 8, ly + 4);
  }

  graphLegendEl.innerHTML = "";
  for (const s of validSeries) {
    const lastPrice = s.points[s.points.length - 1]?.p;
    const item = document.createElement("span");
    item.className = "legend-item";
    item.innerHTML =
      `<span style="color:${escapeHtml(s.color)};font-weight:700;">■</span> ${escapeHtml(s.stock.name)}` +
      ` <strong>${escapeHtml(formatDisplayMoney(lastPrice || 0))} ${escapeHtml(latestCurrency)}</strong>`;
    graphLegendEl.appendChild(item);
  }
}

function trendLabel(trend, control) {
  const suffix = control === "manual" ? " (수동)" : " (자동)";
  if (trend === "up") return "상승" + suffix;
  if (trend === "down") return "하락" + suffix;
  return "표준" + suffix;
}

function openStockEditModal(stock) {
  editingStockId = stock.id;
  editBasePriceInput.value = Number(stock.basePrice ?? 0).toFixed(2);
  editCurrentPriceInput.value = Number(stock.currentPrice ?? 0).toFixed(2);
  editVolatilityInput.value = Number(stock.baseVolatility ?? 0).toFixed(2);
  stockEditModalEl.classList.remove("hidden");
}

function closeStockEditModal() {
  editingStockId = null;
  stockEditModalEl.classList.add("hidden");
}

async function refreshLeaderboard() {
  const res = await api("/api/leaderboard");
  if (!res.ok) return;
  const rows = Array.isArray(res.data?.leaderboard) ? res.data.leaderboard : [];
  leaderboardBodyEl.innerHTML = "";
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5">데이터 없음</td>`;
    leaderboardBodyEl.appendChild(tr);
    return;
  }

  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    const avatar = row.avatarUrl
      ? `<img class="lb-avatar" src="${escapeHtml(row.avatarUrl)}" alt="avatar" />`
      : `<span class="lb-avatar lb-fallback">?</span>`;
    const nickname = escapeHtml(row.nickname || row.userId || "unknown");
    const userId = escapeHtml(row.userId || "");
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>
        <div class="lb-user">
          ${avatar}
          <div class="lb-user-text">
            <strong>${nickname}</strong>
            <small>${userId}</small>
          </div>
        </div>
      </td>
      <td>${escapeHtml(formatDisplayMoney(row.total))} ${escapeHtml(latestCurrency)}</td>
      <td>${escapeHtml(formatDisplayMoney(row.cash))} ${escapeHtml(latestCurrency)}</td>
      <td>${escapeHtml(formatDisplayMoney(row.stockValue))} ${escapeHtml(latestCurrency)}</td>
    `;
    leaderboardBodyEl.appendChild(tr);
  });
}

function renderMoneyUnitList() {
  moneyUnitListEl.innerHTML = "";
  for (let i = 0; i < moneyDisplayUnits.length; i += 1) {
    const u = moneyDisplayUnits[i];
    const item = document.createElement("span");
    item.className = "unit-item";
    item.innerHTML = `<strong>${u.value.toLocaleString("ko-KR")}</strong> ${escapeHtml(u.label)}`;
    const delBtn = document.createElement("button");
    delBtn.textContent = "삭제";
    delBtn.onclick = () => {
      moneyDisplayUnits.splice(i, 1);
      moneyDisplayUnits = normalizeDisplayUnits(moneyDisplayUnits);
      renderMoneyUnitList();
      settingsDirty = true;
    };
    item.appendChild(delBtn);
    moneyUnitListEl.appendChild(item);
  }
}

function renderEvents(events) {
  eventListEl.innerHTML = "";
  if (!events.length) {
    eventListEl.textContent = "이벤트가 없습니다.";
    return;
  }
  for (const ev of events) {
    const row = document.createElement("div");
    row.className = "stock-item";
    const info = document.createElement("div");
    info.innerHTML = `
      <strong>${escapeHtml(ev.title)}</strong>
      <div>가격: ${escapeHtml(formatDisplayMoney(ev.price))} ${escapeHtml(latestCurrency)}</div>
      <div>성공 배율: ${Number(ev.successMultiplier || 1).toFixed(2)}x</div>
      <div>상태: ${ev.status === "open" ? "진행중" : `종료(${ev.result === "success" ? "성공" : "실패"})`}</div>
    `;
    const actions = document.createElement("div");
    actions.className = "stock-actions";
    if (ev.status === "open") {
      const successBtn = document.createElement("button");
      successBtn.className = "ok";
      successBtn.textContent = "성공 종료";
      successBtn.onclick = async () => {
        const out = await api(`/api/events/${ev.id}/close`, {
          method: "POST",
          body: JSON.stringify({ result: "success" }),
        });
        if (out.ok) {
          setStatus("이벤트를 성공으로 종료했습니다.");
          refresh({ forceSettingsSync: true });
        } else {
          setStatus(`종료 실패: ${out.error || "unknown error"}`);
        }
      };
      const failBtn = document.createElement("button");
      failBtn.className = "danger";
      failBtn.textContent = "실패 종료";
      failBtn.onclick = async () => {
        const out = await api(`/api/events/${ev.id}/close`, {
          method: "POST",
          body: JSON.stringify({ result: "fail" }),
        });
        if (out.ok) {
          setStatus("이벤트를 실패로 종료했습니다.");
          refresh({ forceSettingsSync: true });
        } else {
          setStatus(`종료 실패: ${out.error || "unknown error"}`);
        }
      };
      actions.appendChild(successBtn);
      actions.appendChild(failBtn);
    }
    row.appendChild(info);
    row.appendChild(actions);
    eventListEl.appendChild(row);
  }
}

function formatDisplayMoney(value) {
  const units = normalizeDisplayUnits(
    latestSettings.moneyDisplayUnits ??
      [
        {
          value: latestSettings.moneyDisplayUnitValue ?? 10000,
          label: latestSettings.moneyDisplayUnitLabel ?? "만",
        },
      ]
  );
  const sign = Number(value) < 0 ? "-" : "";
  const abs = Math.abs(Number(value));
  const rounded = Number(abs.toFixed(2));
  const intPart = Math.trunc(rounded);
  const frac = Number((rounded - intPart).toFixed(2));

  let remaining = intPart;
  const parts = [];
  for (const unit of units) {
    if (unit.value <= 1) continue;
    if (remaining < unit.value) continue;
    const q = Math.floor(remaining / unit.value);
    remaining %= unit.value;
    parts.push(`${String(q)}${unit.label}`);
  }
  if (remaining > 0 || parts.length === 0) {
    parts.push(String(remaining));
  }
  let baseText = parts.join(" ");
  if (frac > 0) {
    const fracText = frac.toFixed(2).split(".")[1];
    return `${sign}${baseText}.${fracText}`;
  }
  return `${sign}${baseText}`;
}

function normalizeDisplayUnits(input) {
  const arr = Array.isArray(input) ? input : [];
  const normalized = [];
  for (const raw of arr) {
    const value = Math.floor(Number(raw?.value));
    const label = String(raw?.label || "").trim().slice(0, 8);
    if (!Number.isFinite(value) || value < 1 || !label) continue;
    normalized.push({ value, label });
  }
  if (normalized.length === 0) normalized.push(...defaultDisplayUnits());
  const dedup = [];
  const seen = new Set();
  for (const u of normalized) {
    const key = `${u.value}:${u.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(u);
  }
  const out = dedup.sort((a, b) => b.value - a.value);
  if (out.length === 1 && out[0].value === 10000 && out[0].label === "만") {
    return defaultDisplayUnits();
  }
  return out;
}

function defaultDisplayUnits() {
  return [
    { value: 1_0000_0000_0000, label: "조" },
    { value: 1_0000_0000, label: "억" },
    { value: 1_0000, label: "만" },
  ];
}

function applySavedTheme() {
  const saved = localStorage.getItem(themeStorageKey);
  const isDark = saved === "dark";
  document.body.classList.toggle("dark", isDark);
  updateThemeToggleLabel(isDark);
}

function updateThemeToggleLabel(isDark) {
  themeToggleBtn.textContent = isDark ? "라이트모드" : "다크모드";
}

applySavedTheme();
refresh();
