const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const dotenv = require("dotenv");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");

dotenv.config();

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "stock-data.json");
const USER_DATA_DIR = path.join(__dirname, "user_data");
const DASHBOARD_DIR = path.join(__dirname, "dashboard");
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me";
const DEFAULT_BALANCE = Number(process.env.DEFAULT_BALANCE || 10000);
const USE_JSON = parseEnvBoolean(process.env.USE_JSON, false);
const DB_HOST = process.env.DB_HOST || "localhost";
const DB_PORT = Number(process.env.DB_PORT || 5432);
const DB_USER = process.env.DB_USER || "postgres";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME || "postgres";

const state = loadState();
ensureStateShape();
loadUsersAndMergeLegacy();
saveState();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commandFactories = [
  makePriceCommand("주식"),
  makePriceCommand("ㅈㅅ"),
  makePriceCommand("시세"),
  makePriceCommand("ㅅㅅ"),
  makeBuyCommand("매수"),
  makeBuyCommand("구매"),
  makeBuyCommand("ㅁㅅ"),
  makeBuyCommand("ㄱㅁ"),
  makeSellCommand("매도"),
  makeSellCommand("판매"),
  makeSellCommand("ㅁㄷ"),
  makeSellCommand("ㅍㅁ"),
  makeAllBuyCommand(),
  makeAllSellCommand(),
  makeGraphCommand("주식그래프"),
  makeDepositCommand(),
  makeEventBetCommand(),
  makeAlertChannelCommand(),
  new SlashCommandBuilder().setName("정보").setDescription("주식 변동률 기준 정보를 확인합니다."),
  new SlashCommandBuilder().setName("이벤트").setDescription("현재 투자 이벤트를 확인합니다."),
  new SlashCommandBuilder().setName("리더보드").setDescription("자산 리더보드를 확인합니다."),
  new SlashCommandBuilder().setName("잔고").setDescription("잔고를 확인합니다."),
  new SlashCommandBuilder().setName("배낭").setDescription("보유 주식을 확인합니다."),
];
const commandsJson = commandFactories.map((c) => c.toJSON());

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands(commandsJson);
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) return;

    const name = interaction.commandName;
    if (["주식", "ㅈㅅ", "시세", "ㅅㅅ"].includes(name)) {
      await interaction.reply({ embeds: [buildMarketEmbed()] });
      return;
    }

    if (["매수", "구매", "ㅁㅅ", "ㄱㅁ"].includes(name)) {
      await handleBuy(interaction);
      return;
    }

    if (["매도", "판매", "ㅁㄷ", "ㅍㅁ"].includes(name)) {
      await handleSell(interaction);
      return;
    }

    if (name === "올매수") {
      await handleAllBuy(interaction);
      return;
    }

    if (name === "올매도") {
      await handleAllSell(interaction);
      return;
    }

    if (name === "잔고") {
      await interaction.reply({ embeds: [buildBalanceEmbed(interaction.user.id)] });
      return;
    }

    if (name === "배낭") {
      await interaction.reply({ embeds: [buildBagEmbed(interaction.user.id)] });
      return;
    }

    if (name === "주식그래프") {
      await handleGraph(interaction);
      return;
    }

    if (name === "리더보드") {
      await handleLeaderboard(interaction);
      return;
    }

    if (name === "입금") {
      await handleDeposit(interaction);
      return;
    }

    if (name === "정보") {
      await handleInfo(interaction);
      return;
    }

    if (name === "이벤트") {
      await handleEventInfo(interaction);
      return;
    }

    if (name === "이벤트투자") {
      await handleEventBet(interaction);
      return;
    }

    if (name === "알림채널") {
      await handleAlertChannel(interaction);
      return;
    }
  } catch (error) {
    console.error(error);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "처리 중 오류가 발생했습니다.", ephemeral: true });
      return;
    }
    await interaction.reply({ content: "처리 중 오류가 발생했습니다.", ephemeral: true });
  }
});

startMarketLoop();

createDashboardServer().listen(DASHBOARD_PORT, () => {
  console.log(`Dashboard: http://localhost:${DASHBOARD_PORT}`);
});

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN이 필요합니다.");
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);

function createDashboardServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      return sendFile(res, "index.html", "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/styles.css") {
      return sendFile(res, "styles.css", "text/css; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/app.js") {
      return sendFile(res, "app.js", "application/javascript; charset=utf-8");
    }

    if (!url.pathname.startsWith("/api/")) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const token = req.headers["x-admin-token"];
    if (token !== ADMIN_TOKEN) {
      sendJson(res, { error: "Unauthorized" }, 401);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, { settings: state.settings, stocks: state.stocks, events: state.events });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/leaderboard") {
      const leaderboard = await buildLeaderboardData(50);
      sendJson(res, { leaderboard });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/events") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const title = String(body.title || "").trim();
      const price = Number(body.price);
      const successMultiplier = Number(body.successMultiplier);
      if (!title || !Number.isFinite(price) || price <= 0 || !Number.isFinite(successMultiplier) || successMultiplier <= 0) {
        sendJson(res, { error: "title/price/successMultiplier are required" }, 400);
        return;
      }
      const event = {
        id: crypto.randomUUID(),
        title,
        price,
        successMultiplier,
        status: "open",
        createdAt: Date.now(),
        closedAt: null,
        result: null,
      };
      state.events.push(event);
      saveState();
      sendJson(res, event, 201);
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/events\/[^/]+\/close$/)) {
      const eventId = url.pathname.split("/")[3];
      const event = state.events.find((e) => e.id === eventId);
      if (!event) return sendJson(res, { error: "Event not found" }, 404);
      if (event.status !== "open") return sendJson(res, { error: "Event already closed" }, 400);
      const body = await readJsonBody(req, res);
      if (!body) return;
      const result = String(body.result || "").toLowerCase();
      if (!["success", "fail"].includes(result)) {
        sendJson(res, { error: "result must be success/fail" }, 400);
        return;
      }
      const settlement = settleEvent(event, result);
      saveState();
      await announceEventResult(event, settlement);
      sendJson(res, { event, settlement });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/stocks") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const name = String(body.name || "").trim();
      const basePrice = Number(body.basePrice);
      const volatility = Number(body.volatility);
      const color = normalizeHexColor(body.color || "#32a852");
      if (!name || !Number.isFinite(basePrice) || !Number.isFinite(volatility) || !color) {
        sendJson(res, { error: "name/basePrice/volatility/color are required" }, 400);
        return;
      }
      const p = Math.max(0.01, basePrice);
      const stock = {
        id: crypto.randomUUID(),
        name,
        basePrice: p,
        currentPrice: p,
        baseVolatility: Math.max(0, volatility),
        trend: "neutral",
        trendControl: "auto",
        delisted: false,
        color,
        history: [{ t: Date.now(), p }],
      };
      state.stocks.push(stock);
      saveState();
      sendJson(res, stock, 201);
      return;
    }

    if (req.method === "PATCH" && url.pathname === "/api/settings") {
      const body = await readJsonBody(req, res);
      if (!body) return;
      if (body.currencySymbol !== undefined) {
        state.settings.currencySymbol = String(body.currencySymbol || "$").slice(0, 8);
      }
      if (body.updateIntervalSec !== undefined) {
        const sec = Number(body.updateIntervalSec);
        if (!Number.isFinite(sec) || sec <= 0) {
          sendJson(res, { error: "updateIntervalSec must be > 0" }, 400);
          return;
        }
        state.settings.updateIntervalSec = Math.floor(sec);
      }
      if (body.safeZonePercent !== undefined) {
        const pct = Number(body.safeZonePercent);
        if (!Number.isFinite(pct) || pct < 0) {
          sendJson(res, { error: "safeZonePercent must be >= 0" }, 400);
          return;
        }
        state.settings.safeZonePercent = pct;
      }
      if (body.redLinePercent !== undefined) {
        const pct = Number(body.redLinePercent);
        if (!Number.isFinite(pct) || pct < 0) {
          sendJson(res, { error: "redLinePercent must be >= 0" }, 400);
          return;
        }
        state.settings.redLinePercent = pct;
      }
      if (body.moneyUnitDivisor !== undefined) {
        const divisor = Number(body.moneyUnitDivisor);
        if (!Number.isFinite(divisor) || divisor <= 0) {
          sendJson(res, { error: "moneyUnitDivisor must be > 0" }, 400);
          return;
        }
        state.settings.moneyUnitDivisor = divisor;
        saveAllUsers();
      }
      if (body.moneyDisplayUnitValue !== undefined) {
        const unitValue = Number(body.moneyDisplayUnitValue);
        if (!Number.isFinite(unitValue) || unitValue < 1) {
          sendJson(res, { error: "moneyDisplayUnitValue must be >= 1" }, 400);
          return;
        }
        state.settings.moneyDisplayUnitValue = Math.floor(unitValue);
      }
      if (body.moneyDisplayUnitLabel !== undefined) {
        state.settings.moneyDisplayUnitLabel = String(body.moneyDisplayUnitLabel || "").slice(0, 8);
      }
      if (body.moneyDisplayUnits !== undefined) {
        state.settings.moneyDisplayUnits = normalizeMoneyDisplayUnits(body.moneyDisplayUnits);
      }
      saveState();
      sendJson(res, state.settings);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/market/depression/on") {
      state.settings.depressionMode = true;
      saveState();
      sendJson(res, { depressionMode: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/market/depression/off") {
      state.settings.depressionMode = false;
      saveState();
      sendJson(res, { depressionMode: false });
      return;
    }

    if (req.method === "PATCH" && url.pathname.match(/^\/api\/stocks\/[^/]+\/color$/)) {
      const stockId = url.pathname.split("/")[3];
      const stock = state.stocks.find((s) => s.id === stockId);
      if (!stock) {
        sendJson(res, { error: "Stock not found" }, 404);
        return;
      }
      const body = await readJsonBody(req, res);
      if (!body) return;
      const color = normalizeHexColor(body.color);
      if (!color) {
        sendJson(res, { error: "color must be hex (#RRGGBB)" }, 400);
        return;
      }
      stock.color = color;
      saveState();
      sendJson(res, stock);
      return;
    }

    if (req.method === "PATCH" && url.pathname.match(/^\/api\/stocks\/[^/]+$/)) {
      const stockId = url.pathname.split("/")[3];
      const stock = state.stocks.find((s) => s.id === stockId);
      if (!stock) {
        sendJson(res, { error: "Stock not found" }, 404);
        return;
      }
      const body = await readJsonBody(req, res);
      if (!body) return;

      if (body.basePrice !== undefined) {
        const n = Number(body.basePrice);
        if (!Number.isFinite(n) || n < 0.01) {
          sendJson(res, { error: "basePrice must be >= 0.01" }, 400);
          return;
        }
        stock.basePrice = n;
      }
      if (body.currentPrice !== undefined) {
        const n = Number(body.currentPrice);
        if (!Number.isFinite(n) || n < 0.01) {
          sendJson(res, { error: "currentPrice must be >= 0.01" }, 400);
          return;
        }
        stock.currentPrice = n;
      }
      if (body.baseVolatility !== undefined) {
        const n = Number(body.baseVolatility);
        if (!Number.isFinite(n) || n < 0) {
          sendJson(res, { error: "baseVolatility must be >= 0" }, 400);
          return;
        }
        stock.baseVolatility = n;
      }

      stock.history = Array.isArray(stock.history) ? stock.history : [];
      stock.history.push({ t: Date.now(), p: stock.currentPrice });
      if (stock.history.length > 30) stock.history = stock.history.slice(-30);

      saveState();
      sendJson(res, stock);
      return;
    }

    if (req.method === "PATCH" && url.pathname.match(/^\/api\/stocks\/[^/]+\/trend$/)) {
      const stockId = url.pathname.split("/")[3];
      const stock = state.stocks.find((s) => s.id === stockId);
      if (!stock) {
        sendJson(res, { error: "Stock not found" }, 404);
        return;
      }
      const body = await readJsonBody(req, res);
      if (!body) return;
      const trend = String(body.trend || "").toLowerCase();
      if (!["up", "down", "neutral"].includes(trend)) {
        sendJson(res, { error: "trend must be up/down/neutral" }, 400);
        return;
      }
      stock.trend = trend;
      stock.trendControl = trend === "neutral" ? "auto" : "manual";
      saveState();
      sendJson(res, stock);
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/stocks\/[^/]+\/delist$/)) {
      const stockId = url.pathname.split("/")[3];
      const stock = state.stocks.find((s) => s.id === stockId);
      if (!stock) return sendJson(res, { error: "Stock not found" }, 404);
      stock.delisted = true;
      saveState();
      sendJson(res, stock);
      return;
    }

    if (req.method === "POST" && url.pathname.match(/^\/api\/stocks\/[^/]+\/relist$/)) {
      const stockId = url.pathname.split("/")[3];
      const stock = state.stocks.find((s) => s.id === stockId);
      if (!stock) return sendJson(res, { error: "Stock not found" }, 404);
      stock.delisted = false;
      saveState();
      sendJson(res, stock);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });
}

function makePriceCommand(name) {
  return new SlashCommandBuilder().setName(name).setDescription("현재 주식 시세를 확인합니다.");
}

function makeBuyCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription("주식을 매수합니다.")
    .addStringOption((o) => o.setName("주식").setDescription("매수할 주식").setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName("수량").setDescription("수량").setMinValue(1).setRequired(true));
}

function makeSellCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription("주식을 매도합니다.")
    .addStringOption((o) => o.setName("주식").setDescription("매도할 주식").setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName("수량").setDescription("수량").setMinValue(1).setRequired(true));
}

function makeAllBuyCommand() {
  return new SlashCommandBuilder()
    .setName("올매수")
    .setDescription("잔고 가능한 만큼 해당 주식을 모두 매수합니다.")
    .addStringOption((o) => o.setName("주식").setDescription("매수할 주식").setRequired(true).setAutocomplete(true));
}

function makeAllSellCommand() {
  return new SlashCommandBuilder()
    .setName("올매도")
    .setDescription("보유한 해당 주식을 전량 매도합니다.")
    .addStringOption((o) => o.setName("주식").setDescription("매도할 주식").setRequired(true).setAutocomplete(true));
}

function makeGraphCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription("주식 변동 그래프를 PNG로 확인합니다. (모두 가능)")
    .addStringOption((o) => o.setName("주식").setDescription("주식명 또는 모두").setRequired(true).setAutocomplete(true));
}

function makeDepositCommand() {
  return new SlashCommandBuilder()
    .setName("입금")
    .setDescription("내 잔고에서 특정 유저에게 돈을 입금합니다.")
    .addUserOption((o) => o.setName("유저").setDescription("입금 대상 유저").setRequired(true))
    .addNumberOption((o) => o.setName("금액").setDescription("입금할 금액").setMinValue(0.01).setRequired(true));
}

function makeEventBetCommand() {
  return new SlashCommandBuilder()
    .setName("이벤트투자")
    .setDescription("열린 투자 이벤트에 참여합니다.")
    .addStringOption((o) => o.setName("이벤트").setDescription("이벤트").setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName("수량").setDescription("수량").setRequired(false).setMinValue(1));
}

function makeAlertChannelCommand() {
  return new SlashCommandBuilder()
    .setName("알림채널")
    .setDescription("이벤트 결과 발표 채널을 지정합니다.")
    .addChannelOption((o) => o.setName("채널").setDescription("결과 발표 채널").setRequired(true));
}

function replyError(interaction, message) {
  return interaction.reply({ content: message, ephemeral: true });
}

function getStockByName(name) {
  return state.stocks.find((s) => s.name === name);
}

function getActiveStockByName(name) {
  return state.stocks.find((s) => s.name === name && !s.delisted);
}

async function registerCommands(commands) {
  if (!process.env.CLIENT_ID) {
    console.warn("CLIENT_ID가 없어 슬래시 커맨드 등록을 건너뜁니다.");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log("Global commands registered.");
}

async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const commandName = interaction.commandName;
  const user = getOrCreateUser(interaction.user.id);

  if (commandName === "이벤트투자") {
    const choices = state.events
      .filter((e) => e.status === "open")
      .filter((e) => e.title.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((e) => ({ name: `${e.title} (${formatMoney(e.price)}${state.settings.currencySymbol})`, value: e.id }));
    await interaction.respond(choices.length ? choices : [{ name: "열린 이벤트 없음", value: "none" }]);
    return;
  }

  if (commandName === "주식그래프") {
    const names = ["모두", ...state.stocks.map((s) => s.name)];
    const choices = names
      .filter((name) => name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((name) => ({ name, value: name }));
    await interaction.respond(choices.length ? choices : [{ name: "모두", value: "모두" }]);
    return;
  }

  if (["매도", "판매", "ㅁㄷ", "ㅍㅁ", "올매도"].includes(commandName)) {
    const ownedNames = Object.entries(user.portfolio)
      .filter(([, pos]) => pos.qty > 0)
      .map(([stockId]) => state.stocks.find((s) => s.id === stockId)?.name)
      .filter(Boolean)
      .filter((name, i, arr) => arr.indexOf(name) === i)
      .filter((name) => name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((name) => ({ name, value: name }));
    await interaction.respond(ownedNames.length ? ownedNames : [{ name: "없음", value: "없음" }]);
    return;
  }

  const choices = state.stocks
    .filter((s) => !s.delisted)
    .filter((s) => s.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((s) => ({ name: s.name, value: s.name }));
  await interaction.respond(choices.length ? choices : [{ name: "없음", value: "없음" }]);
}

function getOrCreateUser(userId) {
  if (!state.users[userId]) {
    state.users[userId] = { balance: DEFAULT_BALANCE, portfolio: {} };
    saveUser(userId);
  }
  return state.users[userId];
}

function getPosition(user, stockId) {
  user.portfolio[stockId] = user.portfolio[stockId] || { qty: 0, totalCost: 0 };
  return user.portfolio[stockId];
}

function calculateUserAsset(user) {
  let stockValue = 0;
  for (const [stockId, pos] of Object.entries(user.portfolio || {})) {
    if (!pos || Number(pos.qty) <= 0) continue;
    const stock = state.stocks.find((s) => s.id === stockId);
    if (!stock || stock.delisted) continue;
    stockValue += Number(pos.qty) * Number(stock.currentPrice);
  }
  const cash = Number(user.balance || 0);
  return {
    cash,
    stockValue,
    total: cash + stockValue,
  };
}

async function buildLeaderboardData(limit = 20) {
  const base = Object.entries(state.users || {})
    .map(([userId, user]) => {
      const asset = calculateUserAsset(user);
      return {
        userId,
        cash: asset.cash,
        stockValue: asset.stockValue,
        total: asset.total,
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, Math.max(1, limit));

  return Promise.all(
    base.map(async (entry) => {
      try {
        const discordUser = await client.users.fetch(entry.userId);
        return {
          ...entry,
          nickname: discordUser?.globalName || discordUser?.username || entry.userId,
          avatarUrl: discordUser?.displayAvatarURL({ extension: "png", size: 64 }) || null,
        };
      } catch {
        return {
          ...entry,
          nickname: entry.userId,
          avatarUrl: null,
        };
      }
    })
  );
}

function executeBuy(user, stock, qty) {
  const cost = stock.currentPrice * qty;
  user.balance -= cost;
  const pos = getPosition(user, stock.id);
  pos.qty += qty;
  pos.totalCost += cost;
  return cost;
}

function executeSell(user, stock, qty) {
  const pos = getPosition(user, stock.id);
  const avg = pos.qty > 0 ? pos.totalCost / pos.qty : 0;
  const costOut = avg * qty;
  pos.qty -= qty;
  pos.totalCost = Math.max(0, pos.totalCost - costOut);
  if (pos.qty <= 0) {
    pos.qty = 0;
    pos.totalCost = 0;
  }
  const income = stock.currentPrice * qty;
  user.balance += income;
  return income;
}

async function handleBuy(interaction) {
  const stock = getActiveStockByName(interaction.options.getString("주식", true));
  const qty = interaction.options.getInteger("수량", true);
  if (!stock) return replyError(interaction, "해당 주식을 찾을 수 없거나 상장폐지 상태입니다.");

  const user = getOrCreateUser(interaction.user.id);
  const price = stock.currentPrice * qty;
  if (user.balance < price) {
    return replyError(
      interaction,
      `잔고 부족: 필요 ${formatMoney(price)} ${state.settings.currencySymbol}, 현재 ${formatMoney(user.balance)}`
    );
  }

  executeBuy(user, stock, qty);
  saveState();
  saveUser(interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(hexToEmbedColor(stock.color))
    .setTitle("매수 완료")
    .addFields(
      { name: "종목", value: stock.name, inline: true },
      { name: "수량", value: `${qty}주`, inline: true },
      { name: "사용 금액", value: `${formatMoney(price)} ${state.settings.currencySymbol}`, inline: true },
      { name: "남은 잔고", value: `${formatMoney(user.balance)} ${state.settings.currencySymbol}`, inline: true }
    );
  await interaction.reply({ embeds: [embed] });
}

async function handleSell(interaction) {
  const stock = getStockByName(interaction.options.getString("주식", true));
  const qty = interaction.options.getInteger("수량", true);
  if (!stock) return replyError(interaction, "해당 주식을 찾을 수 없습니다.");
  if (stock.delisted) return replyError(interaction, "[상장폐지된 주식]은 매도할 수 없습니다.");

  const user = getOrCreateUser(interaction.user.id);
  const position = getPosition(user, stock.id);
  if (position.qty < qty) return replyError(interaction, "보유 수량이 부족합니다.");

  const income = executeSell(user, stock, qty);
  saveState();
  saveUser(interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(hexToEmbedColor(stock.color))
    .setTitle("매도 완료")
    .addFields(
      { name: "종목", value: stock.name, inline: true },
      { name: "수량", value: `${qty}주`, inline: true },
      { name: "수령 금액", value: `${formatMoney(income)} ${state.settings.currencySymbol}`, inline: true },
      { name: "현재 잔고", value: `${formatMoney(user.balance)} ${state.settings.currencySymbol}`, inline: true }
    );
  await interaction.reply({ embeds: [embed] });
}

async function handleAllBuy(interaction) {
  const stock = getActiveStockByName(interaction.options.getString("주식", true));
  if (!stock) return replyError(interaction, "해당 주식을 찾을 수 없거나 상장폐지 상태입니다.");

  const user = getOrCreateUser(interaction.user.id);
  const qty = Math.floor(user.balance / stock.currentPrice);
  if (qty <= 0) {
    return replyError(
      interaction,
      `잔고가 부족해 1주도 매수할 수 없습니다. 현재가 ${formatMoney(stock.currentPrice)} ${state.settings.currencySymbol}`
    );
  }

  const spent = executeBuy(user, stock, qty);
  saveState();
  saveUser(interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(hexToEmbedColor(stock.color))
    .setTitle("올매수 완료")
    .setDescription(`${stock.name} ${qty}주 매수`)
    .addFields(
      { name: "사용 금액", value: `${formatMoney(spent)} ${state.settings.currencySymbol}`, inline: true },
      { name: "남은 잔고", value: `${formatMoney(user.balance)} ${state.settings.currencySymbol}`, inline: true }
    );
  await interaction.reply({ embeds: [embed] });
}

async function handleAllSell(interaction) {
  const stock = getStockByName(interaction.options.getString("주식", true));
  if (!stock) return replyError(interaction, "해당 주식을 찾을 수 없습니다.");
  if (stock.delisted) return replyError(interaction, "[상장폐지된 주식]은 매도할 수 없습니다.");

  const user = getOrCreateUser(interaction.user.id);
  const position = getPosition(user, stock.id);
  if (position.qty <= 0) return replyError(interaction, "해당 주식을 보유하고 있지 않습니다.");

  const qty = position.qty;
  const income = executeSell(user, stock, qty);
  saveState();
  saveUser(interaction.user.id);
  const embed = new EmbedBuilder()
    .setColor(hexToEmbedColor(stock.color))
    .setTitle("올매도 완료")
    .setDescription(`${stock.name} ${qty}주 전량 매도`)
    .addFields(
      { name: "수령 금액", value: `${formatMoney(income)} ${state.settings.currencySymbol}`, inline: true },
      { name: "현재 잔고", value: `${formatMoney(user.balance)} ${state.settings.currencySymbol}`, inline: true }
    );
  await interaction.reply({ embeds: [embed] });
}

async function handleGraph(interaction) {
  const arg = interaction.options.getString("주식", true);
  let pngBuffer;
  let title;
  let description = "";

  if (arg === "모두") {
    const activeStocks = state.stocks.filter((s) => !s.delisted);
    if (activeStocks.length === 0) return replyError(interaction, "그래프를 그릴 상장 주식이 없습니다.");
    pngBuffer = renderGraphPng(activeStocks, true);
    title = "전체 주식 그래프";
    description = activeStocks.map((s, i) => `${i + 1}. ${s.name} (${s.color})`).join("\n");
  } else {
    const stock = getStockByName(arg);
    if (!stock) return replyError(interaction, "해당 주식을 찾을 수 없습니다.");
    pngBuffer = renderGraphPng([stock], false);
    title = `${stock.name} 그래프`;
  }

  const file = new AttachmentBuilder(pngBuffer, { name: "stock-graph.png" });
  await interaction.reply({ content: description ? `${title}\n${description}` : title, files: [file] });
}

async function handleLeaderboard(interaction) {
  const rows = await buildLeaderboardData(10);
  const embed = new EmbedBuilder().setColor(0xffc107).setTitle("리더보드 TOP 10");
  if (!rows.length) {
    embed.setDescription("리더보드 데이터가 없습니다.");
    await interaction.reply({ embeds: [embed] });
    return;
  }

  const lines = rows.map((row, idx) => {
    const rank = idx + 1;
    const nick = row.nickname || row.userId;
    return `${rank}. ${nick} | 총자산 ${formatMoney(row.total)} ${state.settings.currencySymbol}`;
  });
  embed.setDescription(lines.join("\n"));
  await interaction.reply({ embeds: [embed] });
}

async function handleDeposit(interaction) {
  const targetUser = interaction.options.getUser("유저", true);
  const amount = Number(interaction.options.getNumber("금액", true));
  if (!Number.isFinite(amount) || amount <= 0) {
    return replyError(interaction, "금액은 0보다 커야 합니다.");
  }

  if (targetUser.id === interaction.user.id) {
    return replyError(interaction, "자신에게는 입금할 수 없습니다.");
  }

  const sender = getOrCreateUser(interaction.user.id);
  if (sender.balance < amount) {
    return replyError(
      interaction,
      `잔고 부족: 현재 ${formatMoney(sender.balance)} ${state.settings.currencySymbol}, 필요 ${formatMoney(amount)} ${
        state.settings.currencySymbol
      }`
    );
  }

  const target = getOrCreateUser(targetUser.id);
  sender.balance -= amount;
  target.balance += amount;
  saveUser(interaction.user.id);
  saveUser(targetUser.id);
  saveState();

  const embed = new EmbedBuilder()
    .setColor(0x22aa66)
    .setTitle("입금 완료")
    .setDescription(
      `${targetUser}에게 ${formatMoney(amount)} ${state.settings.currencySymbol} 입금했습니다.\n내 잔고: ${formatMoney(
        sender.balance
      )} ${state.settings.currencySymbol}\n상대 잔고: ${formatMoney(target.balance)} ${state.settings.currencySymbol}`
    );
  await interaction.reply({ embeds: [embed] });
}

async function handleEventInfo(interaction) {
  const openEvents = state.events.filter((e) => e.status === "open");
  const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle("현재 이벤트");
  if (!openEvents.length) {
    embed.setDescription("진행 중인 이벤트가 없습니다.");
    await interaction.reply({ embeds: [embed] });
    return;
  }
  for (const event of openEvents.slice(0, 25)) {
    embed.addFields({
      name: event.title,
      value: `가격 ${formatMoney(event.price)} ${state.settings.currencySymbol} | 성공 배율 ${event.successMultiplier}x`,
      inline: false,
    });
  }
  await interaction.reply({ embeds: [embed] });
}

async function handleEventBet(interaction) {
  const eventId = interaction.options.getString("이벤트", true);
  if (eventId === "none") return replyError(interaction, "참여 가능한 이벤트가 없습니다.");
  const qty = interaction.options.getInteger("수량") || 1;
  const event = state.events.find((e) => e.id === eventId && e.status === "open");
  if (!event) return replyError(interaction, "해당 이벤트를 찾을 수 없거나 이미 종료되었습니다.");

  const user = getOrCreateUser(interaction.user.id);
  const cost = event.price * qty;
  if (user.balance < cost) {
    return replyError(
      interaction,
      `잔고 부족: 필요 ${formatMoney(cost)} ${state.settings.currencySymbol}, 현재 ${formatMoney(user.balance)} ${
        state.settings.currencySymbol
      }`
    );
  }

  user.balance -= cost;
  user.eventBets = user.eventBets || {};
  user.eventBets[event.id] = user.eventBets[event.id] || { amount: 0, qty: 0, title: event.title };
  user.eventBets[event.id].amount += cost;
  user.eventBets[event.id].qty += qty;
  user.eventBets[event.id].title = event.title;
  saveUser(interaction.user.id);
  saveState();

  const embed = new EmbedBuilder()
    .setColor(0x8e44ad)
    .setTitle("이벤트 투자 완료")
    .setDescription(
      `${event.title}\n수량 ${qty} | 지출 ${formatMoney(cost)} ${state.settings.currencySymbol}\n남은 잔고: ${formatMoney(
        user.balance
      )} ${state.settings.currencySymbol}`
    );
  await interaction.reply({ embeds: [embed] });
}

async function handleAlertChannel(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return replyError(interaction, "서버 관리 권한이 필요합니다.");
  }
  const channel = interaction.options.getChannel("채널", true);
  state.settings.eventAnnounceChannelId = channel.id;
  saveState();
  await interaction.reply(`이벤트 발표 채널을 ${channel}로 설정했습니다.`);
}

async function handleInfo(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x4c8dff)
    .setTitle("주식 변동률 기준 정보")
    .setDescription(
      [
        `1) 변동은 현재가 곱셈이 아니라 기본가 기준 선형 적용`,
        `   deltaAmount = basePrice * (deltaPct / 100)`,
        "",
        "2) 추세별 변동률(deltaPct) 랜덤 범위",
        "   - 표준: -baseVolatility ~ +baseVolatility",
        "   - 상승: 0 ~ (baseVolatility * 200%)",
        "   - 하락: -(baseVolatility * 20%) ~ 0",
        "",
        "3) 자동 추세(자동 모드인 종목만 적용)",
        `   - 현재가 < basePrice * (safeZonePercent / 100): 상승`,
        `   - 현재가 > basePrice * (redLinePercent / 100): 하락`,
        "   - 그 외: 표준",
        "",
        `4) 대공황 모드: 변동률 무시, 매 틱 basePrice*750% 강제 하락`,
      ].join("\n")
    )
    .setFooter({
      text: `safeZonePercent와 redLinePercent는 언제나 변동될 수 있음.`,
    });
  await interaction.reply({ embeds: [embed] });
}

function buildMarketEmbed() {
  const active = state.stocks.filter((s) => !s.delisted);
  const embed = new EmbedBuilder().setColor(0x2d82ff).setTitle("현재 주식 시세");
  if (active.length === 0) {
    embed.setDescription("등록된 주식이 없습니다.");
    return embed;
  }

  for (const stock of active.slice(0, 25)) {
    const prev = stock.history.length > 1 ? stock.history[stock.history.length - 2].p : stock.currentPrice;
    const diff = stock.currentPrice - prev;
    const sign = diff >= 0 ? "+" : "";
    const deltaText = `${sign}${formatMoney(diff)} (${sign}${formatPercent((diff / Math.max(prev, 0.01)) * 100)}%)`;
    embed.addFields({
      name: stock.name,
      value:
        `${formatMoney(stock.currentPrice)} ${state.settings.currencySymbol}\n` +
        `${makeAnsiDeltaLine("변화", diff, deltaText)}\n` +
        `기본 변동률 ${formatPercent(stock.baseVolatility)}%`,
      inline: true,
    });
  }
  embed.setFooter({ text: `갱신 주기: ${state.settings.updateIntervalSec}초` });
  return embed;
}

function buildBalanceEmbed(userId) {
  const user = getOrCreateUser(userId);
  let holdingsValue = 0;
  for (const [stockId, pos] of Object.entries(user.portfolio)) {
    if (pos.qty <= 0) continue;
    const stock = state.stocks.find((s) => s.id === stockId);
    if (stock && !stock.delisted) holdingsValue += pos.qty * stock.currentPrice;
  }
  const total = user.balance + holdingsValue;
  return new EmbedBuilder()
    .setColor(0x3cb371)
    .setTitle("잔고")
    .addFields(
      { name: "현금", value: `${formatMoney(user.balance)} ${state.settings.currencySymbol}`, inline: true },
      { name: "주식 평가금", value: `${formatMoney(holdingsValue)} ${state.settings.currencySymbol}`, inline: true },
      { name: "총 자산", value: `${formatMoney(total)} ${state.settings.currencySymbol}`, inline: true }
    );
}

function buildBagEmbed(userId) {
  const user = getOrCreateUser(userId);
  const embed = new EmbedBuilder().setColor(0xf4b400).setTitle("배낭");
  const entries = Object.entries(user.portfolio).filter(([, pos]) => pos.qty > 0);
  const eventEntries = Object.entries(user.eventBets || {}).filter(([, bet]) => Number(bet?.qty || 0) > 0);
  if (entries.length === 0 && eventEntries.length === 0) {
    embed.setDescription("보유 중인 주식이 없습니다.");
    return embed;
  }
  if (entries.length === 0) {
    embed.setDescription("보유 주식은 없고, 이벤트 투자 내역만 있습니다.");
  }

  let totalValue = 0;
  let totalCost = 0;
  for (const [stockId, pos] of entries.slice(0, 25)) {
    const stock = state.stocks.find((s) => s.id === stockId);
    if (!stock || stock.delisted) {
      embed.addFields({
        name: "[상장폐지된 주식 :skull:]",
        value: `수량 ${pos.qty}주\n원가 ${formatMoney(pos.totalCost)} ${state.settings.currencySymbol}`,
        inline: false,
      });
      continue;
    }
    const value = pos.qty * stock.currentPrice;
    const pnl = value - pos.totalCost;
    const pnlPct = pos.totalCost > 0 ? (pnl / pos.totalCost) * 100 : 0;
    const pnlText = `${formatSignedMoney(pnl)} ${state.settings.currencySymbol} (${formatSignedPercent(pnlPct)}%)`;
    totalValue += value;
    totalCost += pos.totalCost;
    embed.addFields({
      name: `${stock.name} (${pos.qty}주)`,
      value:
        `현재 평가 ${formatMoney(value)} ${state.settings.currencySymbol}\n` +
        `${makeAnsiDeltaLine("손익", pnl, pnlText)}`,
      inline: false,
    });
  }
  const totalPnl = totalValue - totalCost;
  const totalPnlText = `${formatSignedMoney(totalPnl)} ${state.settings.currencySymbol} (${formatSignedPercent(
    totalCost > 0 ? (totalPnl / totalCost) * 100 : 0
  )}%)`;
  embed.addFields({
    name: "총 손익",
    value: makeAnsiDeltaLine("총 손익", totalPnl, totalPnlText),
    inline: false,
  });

  if (eventEntries.length > 0) {
    for (const [eventId, bet] of eventEntries.slice(0, 15)) {
      const event = state.events.find((e) => e.id === eventId);
      const title = event?.title || bet.title || "이벤트";
      embed.addFields({
        name: `[이벤트 투자] ${title}`,
        value: `수량 ${bet.qty} | 투자금 ${formatMoney(bet.amount)} ${state.settings.currencySymbol}`,
        inline: false,
      });
    }
  }
  return embed;
}

function startMarketLoop() {
  const loop = () => {
    const intervalMs = Math.max(0, Number(state.settings.updateIntervalSec || 60)) * 1000;
    setTimeout(() => {
      tickMarket();
      saveState();
      loop();
    }, intervalMs);
  };
  loop();
}

function tickMarket() {
  const now = Date.now();
  for (const stock of state.stocks) {
    const safeThreshold = stock.basePrice * (Number(state.settings.safeZonePercent || 0) / 100);
    const redLineThreshold = stock.basePrice * (Number(state.settings.redLinePercent || 0) / 100);
    if (stock.trendControl !== "manual") {
      if (stock.currentPrice > redLineThreshold) {
        stock.trend = "down";
      } else if (stock.currentPrice < safeThreshold) {
        stock.trend = "up";
      } else {
        stock.trend = "neutral";
      }
      stock.trendControl = "auto";
    }

    if (!state.settings.depressionMode && stock.delisted) continue;

    if (state.settings.depressionMode) {
      const forcedDrop = stock.basePrice * 0.56 * Math.random();
      stock.currentPrice = Math.max(0.01, stock.currentPrice - forcedDrop);
      stock.history.push({ t: now, p: stock.currentPrice });
      if (stock.history.length > 30) stock.history = stock.history.slice(-30);
      continue;
    }

    const baseVol = Math.max(0, stock.baseVolatility);
    let deltaPct = 0;
    if (stock.trend === "up") {
      deltaPct = Math.random() * (baseVol * 2);
    } else if (stock.trend === "down") {
      deltaPct = -(Math.random() * (baseVol * 0.2));
    } else {
      deltaPct = (Math.random() * 2 - 1) * baseVol;
    }
    const deltaAmount = stock.basePrice * (deltaPct / 100);
    stock.currentPrice = Math.max(0.01, stock.currentPrice + deltaAmount);
    stock.history.push({ t: now, p: stock.currentPrice });
    if (stock.history.length > 30) stock.history = stock.history.slice(-30);
  }
}

function renderGraphPng(stocks, isAllMode) {
  const width = 1320;
  const height = 700;
  const left = 95;
  const right = 120;
  const top = 40;
  const bottom = 85;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const data = new Uint8Array(width * height * 4);

  fillRect(data, width, height, 0, 0, width, height, [14, 18, 27, 255]);
  fillRect(data, width, height, left, top, plotW, plotH, [23, 30, 44, 255]);

  const series = stocks.map((stock) => ({
    stock,
    points: (stock.history.length ? stock.history : [{ t: Date.now(), p: stock.currentPrice }]).slice(-180),
    color: hexToRgba(stock.color),
  }));
  const allPrices = series.flatMap((s) => s.points.map((p) => p.p));
  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);
  const { yMin, yMax, step } = computeAxis(minP, maxP);
  const decimals = axisDecimals(step);

  for (let yValue = yMin; yValue <= yMax + step / 2; yValue += step) {
    const ratio = (yValue - yMin) / Math.max(yMax - yMin, 0.0001);
    const y = Math.round(top + plotH - ratio * plotH);
    drawLine(data, width, height, left, y, left + plotW, y, [57, 72, 99, 255]);
    drawText(data, width, height, 12, y - 6, formatAxisValue(yValue, decimals), [180, 196, 225, 255], 2);
  }

  for (let i = 0; i < series.length; i += 1) {
    const s = series[i];
    if (s.points.length < 2) continue;
    for (let j = 1; j < s.points.length; j += 1) {
      const p0 = s.points[j - 1].p;
      const p1 = s.points[j].p;
      const x0 = Math.round(left + ((j - 1) / (s.points.length - 1)) * plotW);
      const x1 = Math.round(left + (j / (s.points.length - 1)) * plotW);
      const y0 = valueToY(p0, yMin, yMax, top, plotH);
      const y1 = valueToY(p1, yMin, yMax, top, plotH);
      drawLine(data, width, height, x0, y0, x1, y1, s.color);
    }

    const last = s.points[s.points.length - 1];
    const lx = left + plotW;
    const ly = valueToY(last.p, yMin, yMax, top, plotH);
    fillRect(data, width, height, lx - 3, ly - 3, 7, 7, [250, 250, 250, 255]);
    fillRect(data, width, height, lx - 2, ly - 2, 5, 5, s.color);
    drawText(data, width, height, lx + 8, ly - 6, formatMoney(last.p), [230, 236, 245, 255], 2);
  }

  if (isAllMode) {
    let legendY = 14;
    for (let i = 0; i < series.length; i += 1) {
      const s = series[i];
      fillRect(data, width, height, left + 6, legendY + 4, 16, 6, s.color);
      drawText(data, width, height, left + 28, legendY, `${i + 1}`, [236, 242, 255, 255], 2);
      legendY += 16;
      if (legendY > top - 10) break;
    }
  }

  return encodePngRgba(width, height, data);
}

function computeAxis(minP, maxP) {
  if (!Number.isFinite(minP) || !Number.isFinite(maxP)) return { yMin: 0, yMax: 100, step: 20 };
  if (Math.abs(maxP - minP) < 1e-8) {
    const pad = Math.max(1, maxP * 0.05);
    minP -= pad;
    maxP += pad;
  }
  const rough = (maxP - minP) / 6;
  const step = niceStep(rough);
  const yMin = Math.floor(minP / step) * step;
  const yMax = Math.ceil(maxP / step) * step;
  return { yMin, yMax, step };
}

function niceStep(v) {
  const safe = Math.max(v, 1e-9);
  const pow = 10 ** Math.floor(Math.log10(safe));
  const n = safe / pow;
  if (n <= 1) return 1 * pow;
  if (n <= 2) return 2 * pow;
  if (n <= 5) return 5 * pow;
  return 10 * pow;
}

function axisDecimals(step) {
  if (step >= 1) return 0;
  return Math.min(4, Math.ceil(-Math.log10(step)));
}

function formatAxisValue(v, decimals) {
  return Number(v).toFixed(decimals);
}

function valueToY(value, yMin, yMax, top, plotH) {
  const ratio = (value - yMin) / Math.max(yMax - yMin, 0.0001);
  return Math.round(top + plotH - ratio * plotH);
}

function fillRect(data, width, height, x, y, w, h, rgba) {
  for (let iy = Math.max(0, y); iy < Math.min(height, y + h); iy += 1) {
    for (let ix = Math.max(0, x); ix < Math.min(width, x + w); ix += 1) {
      const idx = (iy * width + ix) * 4;
      data[idx] = rgba[0];
      data[idx + 1] = rgba[1];
      data[idx + 2] = rgba[2];
      data[idx + 3] = rgba[3];
    }
  }
}

function drawLine(data, width, height, x0, y0, x1, y1, rgba) {
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1;
  let sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    setPixel(data, width, height, x0, y0, rgba);
    if (x0 === x1 && y0 === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

function setPixel(data, width, height, x, y, rgba) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const idx = (y * width + x) * 4;
  data[idx] = rgba[0];
  data[idx + 1] = rgba[1];
  data[idx + 2] = rgba[2];
  data[idx + 3] = rgba[3];
}

const FONT = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  ".": ["000", "000", "000", "000", "010"],
  "-": ["000", "000", "111", "000", "000"],
  "+": ["000", "010", "111", "010", "000"],
  " ": ["000", "000", "000", "000", "000"],
};

function drawText(data, width, height, x, y, text, rgba, scale = 2) {
  let cursor = x;
  const input = String(text || "");
  for (const ch of input) {
    const glyph = FONT[ch] || FONT[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] !== "1") continue;
        fillRect(data, width, height, cursor + col * scale, y + row * scale, scale, scale, rgba);
      }
    }
    cursor += 4 * scale;
  }
}

function loadState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    return {
      settings: {
        currencySymbol: "$",
        updateIntervalSec: 60,
        depressionMode: false,
        safeZonePercent: 100,
        redLinePercent: 300,
        moneyUnitDivisor: 1,
        moneyDisplayUnitValue: 10000,
        moneyDisplayUnitLabel: "만",
        moneyDisplayUnits: defaultMoneyDisplayUnits(),
        eventAnnounceChannelId: "",
      },
      stocks: [],
      events: [],
      users: {},
    };
  }
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const divisor = normalizeMoneyUnitDivisor(raw.settings?.moneyUnitDivisor);
  const settings = {
    ...(raw.settings || {}),
    moneyUnitDivisor: divisor,
  };
  const stocks = Array.isArray(raw.stocks) ? raw.stocks.map((s) => decodeStockMoney(s, divisor)) : [];
  const events = Array.isArray(raw.events) ? raw.events.map((e) => decodeEventMoney(e, divisor)) : [];
  const users = raw.users && typeof raw.users === "object" ? decodeLegacyUsers(raw.users, divisor) : {};
  return { settings, stocks, events, users };
}

function ensureStateShape() {
  state.settings = state.settings || {};
  if (!state.settings.currencySymbol) state.settings.currencySymbol = "$";
  if (!state.settings.updateIntervalSec) state.settings.updateIntervalSec = 60;
  state.settings.depressionMode = Boolean(state.settings.depressionMode);
  if (!Number.isFinite(Number(state.settings.safeZonePercent))) state.settings.safeZonePercent = 100;
  state.settings.safeZonePercent = Math.max(0, Number(state.settings.safeZonePercent));
  if (!Number.isFinite(Number(state.settings.redLinePercent))) state.settings.redLinePercent = 300;
  state.settings.redLinePercent = Math.max(0, Number(state.settings.redLinePercent));
  state.settings.moneyUnitDivisor = normalizeMoneyUnitDivisor(state.settings.moneyUnitDivisor);
  if (!Number.isFinite(Number(state.settings.moneyDisplayUnitValue))) state.settings.moneyDisplayUnitValue = 10000;
  state.settings.moneyDisplayUnitValue = Math.max(1, Math.floor(Number(state.settings.moneyDisplayUnitValue)));
  if (typeof state.settings.moneyDisplayUnitLabel !== "string") state.settings.moneyDisplayUnitLabel = "만";
  if (typeof state.settings.eventAnnounceChannelId !== "string") state.settings.eventAnnounceChannelId = "";
  state.settings.moneyDisplayUnits = normalizeMoneyDisplayUnits(
    state.settings.moneyDisplayUnits ||
      [
        {
          value: state.settings.moneyDisplayUnitValue,
          label: state.settings.moneyDisplayUnitLabel,
        },
      ]
  );

  state.stocks = Array.isArray(state.stocks) ? state.stocks : [];
  state.events = Array.isArray(state.events) ? state.events : [];
  for (const stock of state.stocks) {
    stock.id = stock.id || crypto.randomUUID();
    stock.basePrice = Number(stock.basePrice || 1);
    stock.currentPrice = Number(stock.currentPrice || stock.basePrice || 1);
    stock.baseVolatility = Number(stock.baseVolatility || 0);
    stock.trend = normalizeTrend(stock.trend);
    if (stock.trendControl === "manual") {
      stock.trendControl = "manual";
    } else if (stock.trendControl === "auto") {
      stock.trendControl = "auto";
    } else {
      stock.trendControl = stock.trend === "neutral" ? "auto" : "manual";
    }
    stock.delisted = Boolean(stock.delisted);
    stock.color = normalizeHexColor(stock.color || "#32a852") || "#32a852";
    stock.history = Array.isArray(stock.history) ? stock.history : [];
    if (stock.history.length === 0) stock.history.push({ t: Date.now(), p: stock.currentPrice });
    if (stock.history.length > 30) stock.history = stock.history.slice(-30);
  }
  for (const event of state.events) {
    event.id = String(event.id || crypto.randomUUID());
    event.title = String(event.title || "이벤트");
    event.price = Number(event.price || 0);
    event.successMultiplier = Number(event.successMultiplier || 1);
    event.status = event.status === "closed" ? "closed" : "open";
    event.result = event.result === "success" || event.result === "fail" ? event.result : null;
    event.createdAt = Number(event.createdAt || Date.now());
    event.closedAt = event.closedAt ? Number(event.closedAt) : null;
  }
  state.users = state.users && typeof state.users === "object" ? state.users : {};
}

function saveState() {
  const divisor = normalizeMoneyUnitDivisor(state.settings.moneyUnitDivisor);
  const out = {
    settings: {
      ...state.settings,
      moneyUnitDivisor: divisor,
    },
    stocks: state.stocks.map((stock) => encodeStockMoney(stock, divisor)),
    events: state.events.map((event) => encodeEventMoney(event, divisor)),
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(out, null, 2), "utf8");
}

function loadUsersAndMergeLegacy() {
  if (USE_JSON) {
    loadUsersFromDiskAndMergeLegacy();
    return;
  }
  console.log("Fetching users from DB...");
  loadUsersFromDbAndMergeLegacy();
}

function loadUsersFromDiskAndMergeLegacy() {
  if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const legacyUsers = state.users && typeof state.users === "object" ? state.users : {};
  const merged = {};

  for (const [userId, userData] of Object.entries(legacyUsers)) {
    merged[userId] = normalizeUserData(userData);
  }

  const files = fs
    .readdirSync(USER_DATA_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  for (const file of files) {
    const userId = file.name.slice(0, -5);
    const userPath = path.join(USER_DATA_DIR, file.name);
    try {
      const parsed = JSON.parse(fs.readFileSync(userPath, "utf8"));
      const sourceDivisor = normalizeMoneyUnitDivisor(parsed._moneyUnitDivisor);
      delete parsed._moneyUnitDivisor;
      merged[userId] = normalizeUserData(parsed, sourceDivisor);
    } catch (error) {
      console.warn(`Failed to load user file: ${userPath}`, error);
    }
  }

  state.users = merged;
  for (const userId of Object.keys(state.users)) {
    saveUser(userId);
  }
}

function parseEnvBoolean(input, fallback = false) {
  if (input == null) return fallback;
  const text = String(input).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function toSqlTextLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPsql(sql, { ignoreError = false } = {}) {
  try {
    return execFileSync(
      "psql",
      [
        "-q",
        "-t",
        "-A",
        "-h",
        DB_HOST,
        "-p",
        String(DB_PORT),
        "-U",
        DB_USER,
        "-d",
        DB_NAME,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PGPASSWORD: DB_PASSWORD,
        },
      }
    );
  } catch (error) {
    if (ignoreError) return "";
    const detail = error?.stderr?.toString?.() || error?.message || String(error);
    throw new Error(`PostgreSQL query failed: ${detail.trim()}`);
  }
}

function ensureUserDataTableDb() {
  runPsql("SET client_min_messages TO warning; CREATE TABLE IF NOT EXISTS user_data (id TEXT PRIMARY KEY, jsonvalue JSONB NOT NULL);");
}

function fetchUsersFromDb() {
  ensureUserDataTableDb();
  const query = `
    SELECT
      json_build_object('id', id, 'payload', jsonvalue)::text
    FROM user_data
  `;
  const output = runPsql(`COPY (${query}) TO STDOUT;`, { ignoreError: false });
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("NOTICE:")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const id = String(parsed?.id || "");
      if (!id) continue;
      const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : {};
      rows.push({ id, payload });
    } catch (error) {
      console.warn("Failed to parse DB user row:", error);
    }
  }
  return rows;
}

function loadUsersFromDbAndMergeLegacy() {
  const legacyUsers = state.users && typeof state.users === "object" ? state.users : {};
  const merged = {};

  for (const [userId, userData] of Object.entries(legacyUsers)) {
    merged[userId] = normalizeUserData(userData);
  }

  const dbUsers = fetchUsersFromDb();
  for (const row of dbUsers) {
    const source = row.payload && typeof row.payload === "object" ? { ...row.payload } : {};
    const sourceDivisor = normalizeMoneyUnitDivisor(source._moneyUnitDivisor);
    delete source._moneyUnitDivisor;
    merged[row.id] = normalizeUserData(source, sourceDivisor);
  }

  state.users = merged;
  for (const userId of Object.keys(state.users)) {
    saveUser(userId);
  }
}

function normalizeUserData(rawUser, sourceDivisor = 1) {
  const divisor = normalizeMoneyUnitDivisor(sourceDivisor);
  const user = rawUser && typeof rawUser === "object" ? { ...rawUser } : {};
  user.balance = Number.isFinite(Number(user.balance))
    ? fromStorageAmount(Number(user.balance), divisor)
    : DEFAULT_BALANCE;
  user.portfolio = user.portfolio && typeof user.portfolio === "object" ? user.portfolio : {};
  user.eventBets = user.eventBets && typeof user.eventBets === "object" ? user.eventBets : {};

  if (user.holdings && typeof user.holdings === "object") {
    for (const [stockId, qtyRaw] of Object.entries(user.holdings)) {
      const qty = Number(qtyRaw);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const stock = state.stocks.find((s) => s.id === stockId);
      const priceRef = stock ? stock.currentPrice : 1;
      const pos = user.portfolio[stockId] || { qty: 0, totalCost: 0 };
      pos.qty += qty;
      pos.totalCost += qty * priceRef;
      user.portfolio[stockId] = pos;
    }
    delete user.holdings;
  }

  for (const [stockId, pos] of Object.entries(user.portfolio)) {
    if (!pos || typeof pos !== "object") {
      user.portfolio[stockId] = { qty: 0, totalCost: 0 };
      continue;
    }
    pos.qty = Number(pos.qty || 0);
    pos.totalCost = fromStorageAmount(Number(pos.totalCost || 0), divisor);
    if (pos.qty <= 0 || pos.totalCost < 0) {
      pos.qty = 0;
      pos.totalCost = 0;
    }
  }

  for (const [eventId, bet] of Object.entries(user.eventBets)) {
    if (!bet || typeof bet !== "object") {
      user.eventBets[eventId] = { amount: 0, qty: 0, title: "" };
      continue;
    }
    bet.amount = fromStorageAmount(Number(bet.amount || 0), divisor);
    bet.qty = Number(bet.qty || 0);
    bet.title = String(bet.title || "");
    if (bet.qty <= 0 || bet.amount <= 0) {
      delete user.eventBets[eventId];
    }
  }
  return user;
}

function saveUser(userId) {
  const user = normalizeUserData(state.users[userId]);
  state.users[userId] = user;
  const divisor = normalizeMoneyUnitDivisor(state.settings.moneyUnitDivisor);
  const encoded = encodeUserMoney(user, divisor);
  if (USE_JSON) {
    if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    const userPath = path.join(USER_DATA_DIR, `${userId}.json`);
    fs.writeFileSync(userPath, JSON.stringify(encoded, null, 2), "utf8");
    return;
  }
  const payload = JSON.stringify(encoded);
  const sql = `
    INSERT INTO user_data (id, jsonvalue)
    VALUES (${toSqlTextLiteral(userId)}, ${toSqlTextLiteral(payload)}::jsonb)
    ON CONFLICT (id) DO UPDATE SET jsonvalue = EXCLUDED.jsonvalue;
  `;
  runPsql(sql);
}

function saveAllUsers() {
  for (const userId of Object.keys(state.users)) {
    saveUser(userId);
  }
}

function sendFile(res, fileName, contentType) {
  const file = fs.readFileSync(path.join(DASHBOARD_DIR, fileName), "utf8");
  res.writeHead(200, { "Content-Type": contentType });
  res.end(file);
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(parsed);
      } catch {
        sendJson(res, { error: "Invalid JSON" }, 400);
        resolve(null);
      }
    });
  });
}

function normalizeMoneyUnitDivisor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

function toStorageAmount(amount, divisor) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Number((n / divisor).toFixed(8));
}

function fromStorageAmount(amount, divisor) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return n * divisor;
}

function encodeStockMoney(stock, divisor) {
  return {
    ...stock,
    basePrice: toStorageAmount(stock.basePrice, divisor),
    currentPrice: toStorageAmount(stock.currentPrice, divisor),
    history: Array.isArray(stock.history)
      ? stock.history.map((h) => ({ t: h.t, p: toStorageAmount(h.p, divisor) }))
      : [],
  };
}

function decodeStockMoney(rawStock, divisor) {
  return {
    ...rawStock,
    basePrice: fromStorageAmount(rawStock.basePrice, divisor),
    currentPrice: fromStorageAmount(rawStock.currentPrice, divisor),
    history: Array.isArray(rawStock.history)
      ? rawStock.history.map((h) => ({ t: h.t, p: fromStorageAmount(h.p, divisor) }))
      : [],
  };
}

function encodeEventMoney(event, divisor) {
  return {
    ...event,
    price: toStorageAmount(event.price, divisor),
  };
}

function decodeEventMoney(rawEvent, divisor) {
  return {
    ...rawEvent,
    price: fromStorageAmount(rawEvent.price, divisor),
  };
}

function encodeUserMoney(user, divisor) {
  const encoded = {
    _moneyUnitDivisor: divisor,
    balance: toStorageAmount(user.balance, divisor),
    portfolio: {},
    eventBets: {},
  };
  for (const [stockId, pos] of Object.entries(user.portfolio || {})) {
    encoded.portfolio[stockId] = {
      qty: Number(pos.qty || 0),
      totalCost: toStorageAmount(pos.totalCost || 0, divisor),
    };
  }
  for (const [eventId, bet] of Object.entries(user.eventBets || {})) {
    encoded.eventBets[eventId] = {
      amount: toStorageAmount(bet.amount || 0, divisor),
      qty: Number(bet.qty || 0),
      title: String(bet.title || ""),
    };
  }
  return encoded;
}

function decodeLegacyUsers(usersMap, divisor) {
  const decoded = {};
  for (const [userId, user] of Object.entries(usersMap || {})) {
    decoded[userId] = normalizeUserData(user, divisor);
  }
  return decoded;
}

function settleEvent(event, result) {
  event.status = "closed";
  event.result = result;
  event.closedAt = Date.now();
  const payouts = [];
  for (const [userId, user] of Object.entries(state.users || {})) {
    const bet = user.eventBets?.[event.id];
    if (!bet || Number(bet.amount || 0) <= 0 || Number(bet.qty || 0) <= 0) continue;
    const invested = Number(bet.amount);
    let payout = 0;
    if (result === "success") {
      payout = invested * Number(event.successMultiplier || 1);
      user.balance += payout;
    }
    payouts.push({ userId, invested, payout });
    delete user.eventBets[event.id];
    saveUser(userId);
  }
  return { result, payouts };
}

async function announceEventResult(event, settlement) {
  const channelId = state.settings.eventAnnounceChannelId;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== "function") return;
    const winners = settlement.payouts.filter((p) => p.payout > 0);
    const message =
      `📢 이벤트가 종료되었습니다: ${event.title}\n결과: ${settlement.result === "success" ? "성공" : "실패"}\n` +
      `참여자: ${settlement.payouts.length}명` +
      (winners.length
        ? `\n지급 인원: ${winners.length}명\n최대 지급: ${formatMoney(
            Math.max(...winners.map((w) => w.payout))
          )} ${state.settings.currencySymbol}`
        : "");
    await channel.send({ content: message });
  } catch (error) {
    console.warn("Failed to announce event result:", error);
  }
}

function normalizeHexColor(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  const withHash = text.startsWith("#") ? text : `#${text}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(withHash)) return null;
  return withHash.toLowerCase();
}

function normalizeTrend(input) {
  const trend = String(input || "neutral").toLowerCase();
  if (trend === "up" || trend === "down" || trend === "neutral") return trend;
  return "neutral";
}

function hexToRgba(hex) {
  const clean = normalizeHexColor(hex) || "#32a852";
  return [
    parseInt(clean.slice(1, 3), 16),
    parseInt(clean.slice(3, 5), 16),
    parseInt(clean.slice(5, 7), 16),
    255,
  ];
}

function hexToEmbedColor(hex) {
  return parseInt((normalizeHexColor(hex) || "#2d82ff").slice(1), 16);
}

function formatMoney(value) {
  const units = normalizeMoneyDisplayUnits(
    state.settings.moneyDisplayUnits ||
      [
        {
          value: state.settings.moneyDisplayUnitValue,
          label: state.settings.moneyDisplayUnitLabel,
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

function formatSignedMoney(value) {
  return `${value >= 0 ? "+" : ""}${formatMoney(value)}`;
}

function formatPercent(value) {
  return Number(value).toFixed(2);
}

function formatSignedPercent(value) {
  return `${value >= 0 ? "+" : ""}${formatPercent(value)}`;
}

function normalizeMoneyDisplayUnits(input) {
  const arr = Array.isArray(input) ? input : [];
  const normalized = [];
  for (const raw of arr) {
    const value = Math.floor(Number(raw?.value));
    const label = String(raw?.label || "").slice(0, 8).trim();
    if (!Number.isFinite(value) || value < 1 || !label) continue;
    normalized.push({ value, label });
  }
  if (normalized.length === 0) normalized.push({ value: 10000, label: "만" });

  const map = new Map();
  for (const u of normalized) {
    const key = `${u.value}:${u.label}`;
    if (!map.has(key)) map.set(key, u);
  }
  const out = Array.from(map.values()).sort((a, b) => b.value - a.value);
  if (out.length === 1 && out[0].value === 10000 && out[0].label === "만") {
    return defaultMoneyDisplayUnits();
  }
  return out;
}

function defaultMoneyDisplayUnits() {
  return [
    { value: 1_0000_0000_0000, label: "조" },
    { value: 1_0000_0000, label: "억" },
    { value: 1_0000, label: "만" },
  ];
}

function makeAnsiDeltaLine(label, delta, bodyText) {
  const mark = delta >= 0 ? "▲" : "▼";
  const color = delta >= 0 ? "\u001b[1;32m" : "\u001b[1;31m";
  return `\`\`\`ansi\n${color}${label} ${mark} ${bodyText}\u001b[0m\n\`\`\``;
}

function renderTrendLabel(trend) {
  const normalized = normalizeTrend(trend);
  if (normalized === "up") return "상승";
  if (normalized === "down") return "하락";
  return "표준";
}

function encodePngRgba(width, height, rgbaData) {
  const bufferData = Buffer.isBuffer(rgbaData) ? rgbaData : Buffer.from(rgbaData);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    const srcStart = y * width * 4;
    bufferData.copy(raw, rowStart + 1, srcStart, srcStart + width * 4);
  }
  const compressed = zlib.deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = makeChunk(
    "IHDR",
    Buffer.from([
      (width >>> 24) & 255,
      (width >>> 16) & 255,
      (width >>> 8) & 255,
      width & 255,
      (height >>> 24) & 255,
      (height >>> 16) & 255,
      (height >>> 8) & 255,
      height & 255,
      8,
      6,
      0,
      0,
      0,
    ])
  );
  const idat = makeChunk("IDAT", compressed);
  const iend = makeChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuffer, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
