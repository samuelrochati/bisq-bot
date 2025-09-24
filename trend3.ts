import {
  Aster,
  AsterDepth,
  AsterTicker,
  AsterKline,
  AsterOrder,
  AsterAccountSnapshot,
} from "./exchanges/aster";
import "dotenv/config";
import {
  TRADE_SYMBOL,
  TRADE_AMOUNT,
  LOSS_LIMIT,
  TRAILING_PROFIT,
  TP_USDT, // <-- NEW: take-profit alvo em USDT (defina no config.ts)
} from "./config";
import {
  toPrice1Decimal,
  isOperating,
  unlockOperating,
  placeStopLossOrder,
  marketClose,
  calcStopLossPrice,
  calcTrailingActivationPrice,
  placeTrailingStopOrder,
  placeMarketOrder,
} from "./utils/order";
import { logTrade, printStatus, TradeLogItem } from "./utils/log";
import { getPosition, getSMA30 } from "./utils/helper";

const aster = new Aster(
  process.env.ASTER_API_KEY!,
  process.env.ASTER_API_SECRET!
);

// 快照数据
let accountSnapshot: AsterAccountSnapshot | null = null;
let openOrders: AsterOrder[] = [];
let depthSnapshot: AsterDepth | null = null;
let tickerSnapshot: AsterTicker | null = null;
let klineSnapshot: AsterKline[] = [];

// 交易统计
let tradeLog: TradeLogItem[] = [];
let totalProfit = 0;
let totalTrades = 0;
// 多类型订单锁
let orderTypeLocks: { [key: string]: boolean } = {};
let orderTypePendingOrderId: { [key: string]: string | null } = {};
let orderTypeUnlockTimer: { [key: string]: NodeJS.Timeout | null } = {};

// 订阅所有推送
aster.watchAccount((data) => {
  accountSnapshot = data;
  // 账户更新不再直接解锁
});
aster.watchOrder((orders: AsterOrder[]) => {
  // 针对每种类型分别判断pendingOrderId是否需要解锁
  Object.keys(orderTypePendingOrderId).forEach((type) => {
    const pendingOrderId = orderTypePendingOrderId[type];
    if (pendingOrderId) {
      const pendingOrder = orders.find(
        (o) => String(o.orderId) === String(pendingOrderId)
      );
      if (pendingOrder) {
        if (pendingOrder.status && pendingOrder.status !== "NEW") {
          unlockOperating(
            orderTypeLocks,
            orderTypeUnlockTimer,
            orderTypePendingOrderId,
            type
          );
        }
      } else {
        // orders 里没有 pendingOrderId 对应的订单，说明已成交或撤销
        unlockOperating(
          orderTypeLocks,
          orderTypeUnlockTimer,
          orderTypePendingOrderId,
          type
        );
      }
    }
  });
  // 过滤掉 market 类型订单再赋值给 openOrders
  openOrders = Array.isArray(orders)
    ? orders.filter((o) => o.type !== "MARKET")
    : [];
});
aster.watchDepth(TRADE_SYMBOL, (depth: AsterDepth) => {
  depthSnapshot = depth;
});
aster.watchTicker(TRADE_SYMBOL, (ticker: AsterTicker) => {
  tickerSnapshot = ticker;
});
aster.watchKline(TRADE_SYMBOL, "1m", (klines: AsterKline[]) => {
  klineSnapshot = klines;
});

// 新增：工具函数
function isReady() {
  return (
    accountSnapshot && tickerSnapshot && depthSnapshot && klineSnapshot.length
  );
}

function isNoPosition(pos: any) {
  return Math.abs(pos.positionAmt) < 0.00001;
}

async function handleOpenPosition(
  lastPrice: number | null,
  lastSMA30: number,
  price: number,
  openOrders: AsterOrder[],
  orderTypeLocks: any,
  aster: Aster,
  TRADE_SYMBOL: string,
  TRADE_AMOUNT: number,
  tradeLog: TradeLogItem[],
  logTrade: any,
  lastOpenOrder: any
) {
  // 撤销所有普通挂单和止损单
  if (openOrders.length > 0) {
    isOperating(orderTypeLocks, "MARKET");
    await aster.cancelAllOrders({ symbol: TRADE_SYMBOL });
  }
  // 仅在价格穿越SMA30时下市价单
  if (lastPrice !== null) {
    if (lastPrice > lastSMA30 && price < lastSMA30) {
      isOperating(orderTypeLocks, "MARKET");
      await placeMarketOrder(
        aster,
        openOrders,
        orderTypeLocks,
        orderTypeUnlockTimer,
        orderTypePendingOrderId,
        "SELL",
        TRADE_AMOUNT,
        (type: any, detail: any) => logTrade(tradeLog, type, detail)
      );
      logTrade(tradeLog, "open", `下穿SMA30，市价开空: SELL @ ${price}`);
      lastOpenOrder.side = "SELL";
      lastOpenOrder.price = price;
    } else if (lastPrice < lastSMA30 && price > lastSMA30) {
      isOperating(orderTypeLocks, "MARKET");
      await placeMarketOrder(
        aster,
        openOrders,
        orderTypeLocks,
        orderTypeUnlockTimer,
        orderTypePendingOrderId,
        "BUY",
        TRADE_AMOUNT,
        (type: any, detail: any) => logTrade(tradeLog, type, detail)
      );
      logTrade(tradeLog, "open", `上穿SMA30，市价开多: BUY @ ${price}`);
      lastOpenOrder.side = "BUY";
      lastOpenOrder.price = price;
    }
  }
}

async function handlePositionManagement(
  pos: any,
  price: number,
  lastSMA30: number,
  openOrders: AsterOrder[],
  orderTypeLocks: any,
  orderTypeUnlockTimer: any,
  orderTypePendingOrderId: any,
  tickerSnapshot: any,
  aster: Aster,
  TRADE_SYMBOL: string,
  LOSS_LIMIT: number,
  TRAILING_PROFIT: number,
  tradeLog: TradeLogItem[],
  logTrade: any,
  lastCloseOrder: any,
  lastStopOrder: any,
  marketClose: any,
  placeStopLossOrder: any,
  placeTrailingStopOrder: any,
  toPrice1Decimal: any
) {
  const direction = pos.positionAmt > 0 ? "long" : "short";
  const absAmt = Math.abs(pos.positionAmt);
  const pnl =
    (direction === "long" ? price - pos.entryPrice : pos.entryPrice - price) *
    absAmt;
  const stopSide: "SELL" | "BUY" = direction === "long" ? "SELL" : "BUY";

  // === NEW: Take-Profit em USDT ===
  if (TP_USDT && (pnl >= TP_USDT || pos.unrealizedProfit >= TP_USDT)) {
    // Cancela ordens pendentes e fecha a mercado
    if (openOrders.length > 0) {
      isOperating(orderTypeLocks, "MARKET");
      const orderIdList = openOrders.map((o) => o.orderId);
      await aster.cancelOrders({ symbol: TRADE_SYMBOL, orderIdList });
    }
    isOperating(orderTypeLocks, "MARKET");
    await marketClose(
      aster,
      openOrders,
      orderTypeLocks,
      orderTypeUnlockTimer,
      orderTypePendingOrderId,
      direction === "long" ? "SELL" : "BUY",
      (type: any, detail: any) => logTrade(tradeLog, type, detail)
    );
    lastCloseOrder.side = null;
    lastCloseOrder.price = null;
    lastStopOrder.side = null;
    lastStopOrder.price = null;
    logTrade(
      tradeLog,
      "close",
      `TP 触发 (≥ ${TP_USDT}u)，市价平仓: ${
        direction === "long" ? "SELL" : "BUY"
      }`
    );
    return { closed: true, pnl };
  }

  // === Stop Loss e Trailing ===
  const stopPrice = calcStopLossPrice(
    pos.entryPrice,
    absAmt,
    direction as "long" | "short",
    LOSS_LIMIT
  );
  const activationPrice = calcTrailingActivationPrice(
    pos.entryPrice,
    absAmt,
    direction as "long" | "short",
    TRAILING_PROFIT
  );

  let hasStop = openOrders.some(
    (o: AsterOrder) => o.type === "STOP_MARKET" && o.side === stopSide
  );
  let hasTrailing = openOrders.some(
    (o: AsterOrder) => o.type === "TRAILING_STOP_MARKET" && o.side === stopSide
  );

  const profitMove = 0.05; // 当盈利≥0.1u, 将 SL 上移到锁定 +0.05u
  const profitMoveStopPrice =
    direction === "long"
      ? toPrice1Decimal(pos.entryPrice + profitMove / absAmt)
      : toPrice1Decimal(pos.entryPrice - profitMove / absAmt);

  const currentStopOrder = openOrders.find(
    (o: AsterOrder) => o.type === "STOP_MARKET" && o.side === stopSide
  );

  if (pnl > 0.1 || pos.unrealizedProfit > 0.1) {
    if (!currentStopOrder) {
      isOperating(orderTypeLocks, "MARKET");
      await placeStopLossOrder(
        aster,
        openOrders,
        orderTypeLocks,
        orderTypeUnlockTimer,
        orderTypePendingOrderId,
        tickerSnapshot,
        stopSide,
        profitMoveStopPrice,
        (type: any, detail: any) => logTrade(tradeLog, type, detail)
      );
      hasStop = true;
      logTrade(
        tradeLog,
        "stop",
        `盈利大于0.1u，挂盈利0.05u止损单: ${stopSide} @ ${profitMoveStopPrice}`
      );
    } else {
      const curStopPrice = parseFloat(currentStopOrder.stopPrice);
      if (Math.abs(curStopPrice - profitMoveStopPrice) > 0.01) {
        isOperating(orderTypeLocks, "MARKET");
        await aster.cancelOrder({
          symbol: TRADE_SYMBOL,
          orderId: currentStopOrder.orderId,
        });
        isOperating(orderTypeLocks, "MARKET");
        await placeStopLossOrder(
          aster,
          openOrders,
          orderTypeLocks,
          orderTypeUnlockTimer,
          orderTypePendingOrderId,
          tickerSnapshot,
          stopSide,
          profitMoveStopPrice,
          (type: any, detail: any) => logTrade(tradeLog, type, detail)
        );
        logTrade(
          tradeLog,
          "stop",
          `盈利大于0.1u，移动止损单到盈利0.05u: ${stopSide} @ ${profitMoveStopPrice}`
        );
        hasStop = true;
      }
    }
  }

  if (!hasStop) {
    isOperating(orderTypeLocks, "MARKET");
    await placeStopLossOrder(
      aster,
      openOrders,
      orderTypeLocks,
      orderTypeUnlockTimer,
      orderTypePendingOrderId,
      tickerSnapshot,
      stopSide,
      toPrice1Decimal(stopPrice),
      (type: any, detail: any) => logTrade(tradeLog, type, detail)
    );
  }

  if (!hasTrailing) {
    isOperating(orderTypeLocks, "MARKET");
    await placeTrailingStopOrder(
      aster,
      openOrders,
      orderTypeLocks,
      orderTypeUnlockTimer,
      orderTypePendingOrderId,
      stopSide,
      toPrice1Decimal(activationPrice),
      absAmt,
      (type: any, detail: any) => logTrade(tradeLog, type, detail)
    );
  }

  // === Hard Stop (LOSS_LIMIT) ===
  if (pnl < -LOSS_LIMIT || pos.unrealizedProfit < -LOSS_LIMIT) {
    if (openOrders.length > 0) {
      isOperating(orderTypeLocks, "MARKET");
      const orderIdList = openOrders.map((o) => o.orderId);
      await aster.cancelOrders({ symbol: TRADE_SYMBOL, orderIdList });
    }
    isOperating(orderTypeLocks, "MARKET");
    await marketClose(
      aster,
      openOrders,
      orderTypeLocks,
      orderTypeUnlockTimer,
      orderTypePendingOrderId,
      direction === "long" ? "SELL" : "BUY",
      (type: any, detail: any) => logTrade(tradeLog, type, detail)
    );
    lastCloseOrder.side = null;
    lastCloseOrder.price = null;
    lastStopOrder.side = null;
    lastStopOrder.price = null;
    logTrade(tradeLog, "close", `止损平仓: ${direction === "long" ? "SELL" : "BUY"}`);
    return { closed: true, pnl };
  }

  return { closed: false, pnl };
}

async function trendStrategy() {
  let lastSMA30: number | null = null;
  let lastPrice: number | null = null;
  let lastOpenOrder = {
    side: null as "BUY" | "SELL" | null,
    price: null as number | null,
  };
  let lastCloseOrder = {
    side: null as "BUY" | "SELL" | null,
    price: null as number | null,
  };
  let lastStopOrder = {
    side: null as "BUY" | "SELL" | null,
    price: null as number | null,
  };

  while (true) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isReady()) continue;

    lastSMA30 = getSMA30(klineSnapshot);
    if (lastSMA30 === null) continue;

    const ob = depthSnapshot!;
    const ticker = tickerSnapshot!;
    const price = parseFloat(ticker.lastPrice);
    const pos = getPosition(accountSnapshot, TRADE_SYMBOL);

    let trend = "无信号";
    if (price < lastSMA30) trend = "做空";
    if (price > lastSMA30) trend = "做多";

    let pnl = 0;

    if (isNoPosition(pos)) {
      await handleOpenPosition(
        lastPrice,
        lastSMA30,
        price,
        openOrders,
        orderTypeLocks,
        aster,
        TRADE_SYMBOL,
        TRADE_AMOUNT,
        tradeLog,
        logTrade,
        lastOpenOrder
      );
      lastStopOrder.side = null;
      lastStopOrder.price = null;
    } else {
      const result = await handlePositionManagement(
        pos,
        price,
        lastSMA30,
        openOrders,
        orderTypeLocks,
        orderTypeUnlockTimer,
        orderTypePendingOrderId,
        ticker,
        aster,
        TRADE_SYMBOL,
        LOSS_LIMIT,
        TRAILING_PROFIT,
        tradeLog,
        logTrade,
        lastCloseOrder,
        lastStopOrder,
        marketClose,
        placeStopLossOrder,
        placeTrailingStopOrder,
        toPrice1Decimal
      );
      pnl = result.pnl;
      if (result.closed) {
        totalTrades++;
        totalProfit += pnl;
        continue;
      }
    }

    printStatus({
      ticker,
      ob,
      sma: lastSMA30,
      trend,
      openOrder:
        isNoPosition(pos) && lastOpenOrder.side && lastOpenOrder.price
          ? { side: lastOpenOrder.side, price: lastOpenOrder.price, amount: TRADE_AMOUNT }
          : null,
      closeOrder:
        !isNoPosition(pos) && lastCloseOrder.side && lastCloseOrder.price
          ? { side: lastCloseOrder.side, price: lastCloseOrder.price, amount: Math.abs(pos.positionAmt) }
          : null,
      stopOrder:
        !isNoPosition(pos) && lastStopOrder.side && lastStopOrder.price
          ? { side: lastStopOrder.side, stopPrice: lastStopOrder.price }
          : null,
      pos,
      pnl,
      unrealized: pos.unrealizedProfit,
      tradeLog,
      totalProfit,
      totalTrades,
      openOrders,
    });

    lastPrice = price;
  }
}

trendStrategy();
