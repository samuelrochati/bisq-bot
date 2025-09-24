// ===== Parâmetros principais =====
export const TRADE_SYMBOL = "BTCUSDT";
export const TRADE_AMOUNT = 0.009; // 0.009 BTC → 1u ~ $111; 0.05u ~ $5.55

// ===== Alvos e risco =====
export const TP_USDT = 2;      // Fecha a mercado ao lucrar 2u (≈ $222 com qty 0.009)
export const LOSS_LIMIT = 0.20; // Stop-loss "duro" em -0.20u (≈ -$22.22)

// ===== Trailing stop =====
// Ativa trailing quando lucro ≥ 1u (≈ $111); callback de 0.05% (≈ $30 de recuo a $60k).
// Obs: se sua exchange interpreta "callback rate" em %, 0.05 == 0.05% (não 5%).
export const TRAILING_PROFIT = 1.0;     // em USDT (lucro)
export const TRAILING_CALLBACK_RATE = 0.05; // em % (0.05%)

// ===== Outros (legado/não usados na trend atual) =====
export const ARB_THRESHOLD = 80;        // [legado] não usado na trend.ts
export const CLOSE_DIFF = 3;            // [legado] não usado na trend.ts
export const PROFIT_DIFF_LIMIT = 1;     // [legado] não usado na trend.ts
export const STOP_LOSS_DIST = 0.1;      // [legado] não usado na trend.ts
