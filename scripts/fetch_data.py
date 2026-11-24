#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""미국장·국장 테마 대시보드 데이터 수집기.

야후 파이낸스 공개 API에서 시세·일봉/주봉·재무·애널리스트 목표가를 받아
docs/data/stocks.json 과 docs/data/hist/{symbol}.json 을 만든다.

- 표준 라이브러리만 사용 (urllib + cookiejar). yfinance 불필요.
- 무료 API 특성: 15분 지연, 일봉 종가 기준.
"""
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import http.cookiejar
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from universe import THEMES_US, THEMES_KR, INDICES, STOCKS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "docs", "data")
HIST_DIR = os.path.join(DATA_DIR, "hist")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")

_cj = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cj))
_crumb = None


def _get(url, tries=4, timeout=25):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "en-US,en;q=0.9",
            })
            with _opener.open(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(1.5 * (i + 1) + random.random())
                continue
            if e.code == 401 and i == 0:
                _refresh_crumb()
                continue
            raise
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.0 * (i + 1) + random.random())
    raise last


def _refresh_crumb():
    global _crumb
    try:
        _get("https://fc.yahoo.com", tries=2)
    except Exception:  # noqa: BLE001
        pass
    try:
        _crumb = _get("https://query1.finance.yahoo.com/v1/test/getcrumb", tries=3).strip()
    except Exception:  # noqa: BLE001
        _crumb = None
    return _crumb


def get_crumb():
    if not _crumb:
        _refresh_crumb()
    return _crumb


def get_json(url):
    return json.loads(_get(url))


# ------------------------------------------------------------------ 수집
def fetch_chart(symbol, rng="2y", interval="1d"):
    q = urllib.parse.urlencode({"range": rng, "interval": interval,
                                "includePrePost": "true", "events": "div,split"})
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{q}"
    d = get_json(url)
    res = (d.get("chart") or {}).get("result") or []
    if not res:
        raise ValueError(f"chart empty: {symbol}")
    return res[0]


def fetch_summary(symbol):
    mods = "price,summaryDetail,summaryProfile,financialData,defaultKeyStatistics"
    for attempt in range(3):
        crumb = get_crumb()
        if not crumb:
            _refresh_crumb()
            time.sleep(0.5)
            continue
        url = (f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/"
               f"{urllib.parse.quote(symbol)}?modules={mods}&crumb={urllib.parse.quote(crumb)}")
        try:
            d = get_json(url)
            res = (d.get("quoteSummary") or {}).get("result") or []
            if res:
                return res[0] or {}
            return {}
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                _refresh_crumb()
                time.sleep(0.6)
                continue
            raise
    return {}


def raw(v, default=None):
    if isinstance(v, dict):
        return v.get("raw", default)
    return v if v is not None else default


def num(v, digits=2):
    v = raw(v)
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, digits)


# ------------------------------------------------------------------ 지표
def sma(vals, n):
    if len(vals) < n:
        return None
    return sum(vals[-n:]) / n


def rsi_wilder(closes, period=14):
    if len(closes) < period + 1:
        return None
    gains, losses = [], []
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    avg_g = sum(gains) / period
    avg_l = sum(losses) / period
    for i in range(period + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        g, l = max(d, 0.0), max(-d, 0.0)
        avg_g = (avg_g * (period - 1) + g) / period
        avg_l = (avg_l * (period - 1) + l) / period
    if avg_l == 0:
        return 100.0
    rs = avg_g / avg_l
    return 100.0 - (100.0 / (1.0 + rs))


def build_indicators(closes, highs, lows, vols, opens):
    price = closes[-1]
    ma20 = sma(closes, 20)
    ma60 = sma(closes, 60)
    ma200 = sma(closes, 200)
    rsi = rsi_wilder(closes, 14)
    n52 = min(len(closes), 252)
    h52 = max(highs[-n52:]) if highs else None
    l52 = min(lows[-n52:]) if lows else None
    pos52 = None
    if h52 and l52 and h52 > l52:
        pos52 = max(0.0, min(100.0, (price - l52) / (h52 - l52) * 100.0))
    prev_vol = vols[-21:-1] if len(vols) >= 21 else vols[:-1]
    avg_vol = sum(prev_vol) / len(prev_vol) if prev_vol else None
    vol_ratio = (vols[-1] / avg_vol) if avg_vol and vols and vols[-1] is not None else None
    daily = {
        "price": round(price, 2),
        "ma20": round(ma20, 2) if ma20 else None,
        "ma60": round(ma60, 2) if ma60 else None,
        "ma200": round(ma200, 2) if ma200 else None,
        "rsi14": round(rsi, 1) if rsi is not None else None,
        "high52": round(h52, 2) if h52 else None,
        "low52": round(l52, 2) if l52 else None,
        "pos52": round(pos52, 1) if pos52 is not None else None,
        "vol_ratio": round(vol_ratio, 2) if vol_ratio else None,
        "candle": "양봉" if opens and closes[-1] >= opens[-1] else "음봉",
    }
    return daily


def judge_filters(d):
    """고수 4중 교차 필터 판정 (사용자 확정 규칙 기반)."""
    price, ma20, ma60, ma200, rsi = d["price"], d["ma20"], d["ma60"], d["ma200"], d["rsi14"]
    hi, lo, pos, vr = d["high52"], d["low52"], d["pos52"], d["vol_ratio"]

    # 1) 추세·바닥: 200일선 위 + 20일선이 60일선 위 (역배열 하락 추세 배제)
    trend = bool(ma200 and price > ma200 and ma20 and ma60 and ma20 > ma60)
    # 2) RSI: 35~50 눌림 구간 (과열 추격 금지)
    rsi_ok = bool(rsi is not None and 35 <= rsi <= 50)
    # 3) 수급: 거래량이 20일 평균의 80% 이상 + 오늘 양봉
    vol_ok = bool(vr is not None and vr >= 0.8 and d["candle"] == "양봉")
    # 4) 손익비: 200일선까지 6% 이내(손절 짧음) + 52주 고점 대비 10% 이상 아래(위 여유)
    risk_ok = bool(ma200 and (ma200 - price) / price <= 0.06 and hi and price <= hi * 0.90)

    checks = [
        {"key": "trend", "label": "추세·바닥", "ok": trend,
         "detail": ("200일선 위에서 20일선 > 60일선 정배열" if trend else
                    ("200일선 아래 — 떨어지는 칼날 구간" if (ma200 and price < ma200) else
                     "20일선이 60일선 아래(역배열) — 추세 미완성"))},
        {"key": "rsi", "label": "RSI 눌림", "ok": rsi_ok,
         "detail": (f"RSI {rsi} — 35~50 눌림 구간" if rsi_ok else
                    (f"RSI {rsi} — 과열(50 초과) 추격 금지" if (rsi and rsi > 50) else
                     f"RSI {rsi} — 35 미만, 하락 진행 중"))},
        {"key": "volume", "label": "거래량·양봉", "ok": vol_ok,
         "detail": ((f"거래량 20일 평균의 {vr}배 · {d['candle']}" if vol_ok else
                     f"거래량 {vr}배 · {d['candle']} — 반등 힘 부족") if vr else
                    "거래량 데이터 부족")},
        {"key": "risk", "label": "손익비·여유", "ok": risk_ok,
         "detail": ("200일선 손절폭 6% 이내 + 52주 고점 대비 여유" if risk_ok else
                    "200일선이 멀거나 52주 고점 부근 — 손익비 불리")},
    ]
    passed = sum(1 for c in checks if c["ok"])
    if passed == 4:
        verdict, tone = "4중 필터 통과 · 매수 후보", "buy"
    elif passed == 3:
        verdict, tone = "3개 통과 · 관찰(눌림 확인)", "watch"
    elif passed == 2:
        verdict, tone = "2개 통과 · 대기", "wait"
    else:
        verdict, tone = "1개 이하 · 진입 보류", "avoid"
    return checks, passed, verdict, tone


def golden_zone(d):
    price, ma200, rsi = d["price"], d["ma200"], d["rsi14"]
    if not ma200:
        return False, "200일선 계산 불가(상장 기간 짧음)"
    near = abs(price - ma200) / ma200 <= 0.03 and price >= ma200 * 0.97
    dip = bool(rsi is not None and 35 <= rsi <= 45 and price > ma200)
    if near and dip:
        return True, "200일선 3% 이내 + RSI 35~45 눌림 — 골든존"
    if near:
        return True, "200일선 3% 이내 — 골든존(매수 고려 구간)"
    if dip:
        return True, "200일선 위 + RSI 35~45 눌림 — 골든존"
    if price > ma200 * 1.10:
        return False, f"200일선보다 {(price/ma200-1)*100:.1f}% 위 — 눌림 대기"
    return False, f"200일선보다 {(price/ma200-1)*100:.1f}% — 아직 구간 아님"


def make_hist(res, digits=2):
    ts = res.get("timestamp") or []
    q = (((res.get("indicators") or {}).get("quote") or [{}])[0])
    opens, highs, lows, closes, vols = q.get("open") or [], q.get("high") or [], q.get("low") or [], q.get("close") or [], q.get("volume") or []
    out = {"t": [], "o": [], "h": [], "l": [], "c": [], "v": []}
    tz_name = ((res.get("meta") or {}).get("exchangeTimezoneName") or "America/New_York")
    from zoneinfo import ZoneInfo
    try:
        tz = ZoneInfo(tz_name)
    except Exception:  # noqa: BLE001
        tz = timezone.utc
    for i, t in enumerate(ts):
        try:
            c = closes[i]
            if c is None:
                continue
            o = opens[i] if i < len(opens) and opens[i] is not None else c
            h = highs[i] if i < len(highs) and highs[i] is not None else c
            l = lows[i] if i < len(lows) and lows[i] is not None else c
            v = vols[i] if i < len(vols) and vols[i] is not None else 0
        except IndexError:
            continue
        out["t"].append(datetime.fromtimestamp(t, tz).strftime("%Y-%m-%d"))
        out["o"].append(round(float(o), digits))
        out["h"].append(round(float(h), digits))
        out["l"].append(round(float(l), digits))
        out["c"].append(round(float(c), digits))
        out["v"].append(int(v or 0))
    return out


def analyst_block(summary, price):
    fd = summary.get("financialData") or {}
    mean, high, low = num(fd.get("targetMeanPrice")), num(fd.get("targetHighPrice")), num(fd.get("targetLowPrice"))
    median = num(fd.get("targetMedianPrice"))
    rec_mean = num(fd.get("recommendationMean"))
    rec_key = raw(fd.get("recommendationKey"))
    n_ops = num(fd.get("numberOfAnalystOpinions"), 0)
    if not mean and not high and not low:
        return {"available": False,
                "note": "목표가 집계 없음 (차트·4중 필터 기준 확인)"}
    key_kr = {"strong_buy": "적극 매수", "buy": "매수", "hold": "보유",
              "underperform": "비중 축소", "sell": "매도", "none": "집계 없음"}.get(rec_key, "집계 없음")
    upside = round((mean / price - 1) * 100, 1) if mean and price else None
    return {
        "available": True,
        "mean": mean, "median": median, "high": high, "low": low,
        "upside_pct": upside,
        "recommendation_mean": rec_mean,
        "recommendation": key_kr,
        "analysts": int(n_ops) if n_ops else None,
        "revenue_growth": num(fd.get("revenueGrowth")),
    }


def master_guide(d, price, gz=False):
    """사용자 4중 필터 손익비 규칙으로 계산한 참고 가격."""
    stop = price * 0.965
    t1 = price * 1.045
    t2 = price * 1.09
    ma200 = d.get("ma200")
    out = {
        "stop": round(stop, 2), "t1": round(t1, 2), "t2": round(t2, 2),
        "note": "손절 -3.5% · 1차 익절 +4.5%(절반) · 2차 +9% · 분할 1차 40%/2차 30%/예비 30%",
    }
    if gz:
        out["entry_note"] = "골든존 구간 — 한 번에 사지 말고 1차 40%만, 나머지는 200일선 이탈·반등 확인 후"
    elif ma200 and price > ma200 * 1.10:
        out["entry_note"] = (f"지금은 200일선보다 {(price/ma200-1)*100:.1f}% 위 — 추격 매수 대신 "
                             f"200일선 부근({ma200:,.2f}) 눌림 대기")
    elif ma200:
        out["entry_note"] = "200일선 부근 — 골든존 분할 진입 가능 구간"
    else:
        out["entry_note"] = "200일선 데이터 부족 — 차트 흐름만 참고"
    return out


# ------------------------------------------------------------------ 조립
def theme_of(symbol, themes):
    hits = []
    for t in themes:
        role = "대장" if t["leader"] == symbol else ("수혜" if symbol in t["members"] else None)
        if role:
            hits.append({"id": t["id"], "name": t["name"], "emoji": t["emoji"], "role": role})
    return hits


def build_market(key, themes, symbols, digits):
    stocks = {}
    errors = []
    for i, sym in enumerate(symbols, 1):
        name_ko, desc = STOCKS.get(sym, (sym, ""))
        try:
            daily_res = fetch_chart(sym, "2y", "1d")
            time.sleep(0.06)
            meta = daily_res.get("meta") or {}
            dh = make_hist(daily_res, digits)
            if len(dh["c"]) < 30:
                raise ValueError("일봉 부족")
            closes = dh["c"]
            opens, highs, lows, vols = dh["o"], dh["h"], dh["l"], dh["v"]
            d = build_indicators(closes, highs, lows, vols, opens)
            prev_close = closes[-2] if len(closes) > 1 else d["price"]
            change = d["price"] - prev_close
            change_pct = (change / prev_close * 100) if prev_close else 0.0

            summary = {}
            try:
                summary = fetch_summary(sym)
            except Exception as e:  # noqa: BLE001
                print(f"  ! summary {sym}: {e}")
            prof = summary.get("summaryProfile") or {}
            pmod = summary.get("price") or {}
            sd = summary.get("summaryDetail") or {}

            checks, passed, verdict, tone = judge_filters(d)
            gz, gz_reason = golden_zone(d)
            an = analyst_block(summary, d["price"])

            cur = "KRW" if sym.endswith((".KS", ".KQ")) else "USD"
            st = {
                "symbol": sym,
                "market": key,
                "currency": cur,
                "name": name_ko,
                "name_en": raw(pmod.get("longName")) or meta.get("longName") or sym,
                "desc": desc,
                "sector": prof.get("sector") or None,
                "industry": prof.get("industry") or None,
                "price": d["price"],
                "prev_close": round(prev_close, digits),
                "change": round(change, digits),
                "change_pct": round(change_pct, 2),
                "day_high": num(pmod.get("regularMarketDayHigh"), digits) or round(highs[-1], digits),
                "day_low": num(pmod.get("regularMarketDayLow"), digits) or round(lows[-1], digits),
                "volume": vols[-1],
                "ma20": d["ma20"], "ma60": d["ma60"], "ma200": d["ma200"],
                "rsi14": d["rsi14"],
                "high52": d["high52"], "low52": d["low52"], "pos52": d["pos52"],
                "vol_ratio": d["vol_ratio"], "candle": d["candle"],
                "ma200_dist_pct": round((d["price"] / d["ma200"] - 1) * 100, 1) if d["ma200"] else None,
                "golden_zone": gz, "golden_note": gz_reason,
                "filters": checks, "filter_count": passed,
                "verdict": verdict, "tone": tone,
                "analyst": an,
                "guide": master_guide(d, d["price"], gz),
                "market_cap": num(pmod.get("marketCap"), 0),
                "pe": num(sd.get("trailingPE")),
                "themes": theme_of(sym, themes),
                "pre_market_price": num(pmod.get("preMarketPrice"), digits),
                "pre_market_pct": num(pmod.get("preMarketChangePercent")),
                "post_market_price": num(pmod.get("postMarketPrice"), digits),
                "post_market_pct": num(pmod.get("postMarketChangePercent")),
            }
            # 히스토리 저장 (종목 상세에서 지연 로딩)
            try:
                wk_res = fetch_chart(sym, "5y", "1wk")
                time.sleep(0.06)
                wh = make_hist(wk_res, digits)
            except Exception as e:  # noqa: BLE001
                print(f"  ! weekly {sym}: {e}")
                wh = {"t": [], "o": [], "h": [], "l": [], "c": [], "v": []}
            os.makedirs(HIST_DIR, exist_ok=True)
            with open(os.path.join(HIST_DIR, f"{sym}.json"), "w", encoding="utf-8") as f:
                json.dump({"symbol": sym, "currency": cur, "daily": dh, "weekly": wh}, f,
                          ensure_ascii=False, separators=(",", ":"))
            stocks[sym] = st
            print(f"[{i}/{len(symbols)}] {sym} {name_ko} {st['price']} ({change_pct:+.2f}%) GZ={gz} F={passed}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"{sym}: {type(e).__name__} {e}")
            print(f"[{i}/{len(symbols)}] !! {sym} FAILED: {e}")
        time.sleep(0.05)
    return stocks, errors


def build_themes(themes, stocks):
    out = []
    for t in themes:
        members = [t["leader"]] + [m for m in t["members"] if m not in (t["leader"],)]
        rows = []
        for sym in members:
            s = stocks.get(sym)
            if not s:
                continue
            rows.append({
                "symbol": sym, "name": s["name"], "price": s["price"],
                "change_pct": s["change_pct"], "role": "대장" if sym == t["leader"] else "수혜",
                "golden_zone": s["golden_zone"], "tone": s["tone"],
                "filter_count": s["filter_count"], "rsi14": s["rsi14"],
                "currency": s["currency"],
            })
        if not rows:
            continue
        ch = [r["change_pct"] for r in rows]
        ups = sum(1 for c in ch if c > 0)
        downs = sum(1 for c in ch if c < 0)
        leader = rows[0]
        out.append({
            "id": t["id"], "name": t["name"], "emoji": t["emoji"],
            "avg_change": round(sum(ch) / len(ch), 2),
            "up": ups, "down": downs,
            "leader": leader,
            "leader_name": leader["name"],
            "stocks": rows,
            "golden_count": sum(1 for r in rows if r["golden_zone"]),
        })
    out.sort(key=lambda x: -x["avg_change"])
    return out


def build_indices(key, stocks):
    out = []
    for ix in INDICES[key]:
        sym = ix["symbol"]
        try:
            res = fetch_chart(sym, "1mo", "1d")
            meta = res.get("meta") or {}
            h = make_hist(res)
            if len(h["c"]) < 2:
                raise ValueError("지수 일봉 부족")
            price = num(meta.get("regularMarketPrice")) or h["c"][-1]
            prev = h["c"][-2]
            chg = (price / prev - 1) * 100 if prev else 0.0
            digits = 2
            out.append({"symbol": sym, "name": ix["name"],
                        "price": round(price, digits), "change_pct": round(chg, 2)})
            time.sleep(0.05)
        except Exception as e:  # noqa: BLE001
            print(f"  ! index {sym}: {e}")
    return out


def main():
    t0 = time.time()
    os.makedirs(DATA_DIR, exist_ok=True)
    get_crumb()
    print("crumb:", bool(_crumb))

    result = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "generated_at_kst": datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d %H:%M KST"),
            "source": "Yahoo Finance 공개 API",
            "delay_note": "무료 공개 데이터 · 약 15분 지연 · 일봉 종가 기준",
            "disclaimer": "투자 판단 참고용. 매수·매도 권유가 아니며 손실 책임은 본인에게 있습니다.",
        },
        "markets": {},
    }

    us_syms = []
    for t in THEMES_US:
        for s in [t["leader"]] + t["members"]:
            if s not in us_syms:
                us_syms.append(s)
    kr_syms = []
    for t in THEMES_KR:
        for s in [t["leader"]] + t["members"]:
            if s not in kr_syms:
                kr_syms.append(s)

    for key, themes, syms, digits in (
        ("us", THEMES_US, us_syms, 2),
        ("kr", THEMES_KR, kr_syms, 0),
    ):
        print(f"== {key} ({len(syms)}종목) ==")
        stocks, errors = build_market(key, themes, syms, digits)
        mk = {
            "label": "🇺🇸 미국장" if key == "us" else "🇰🇷 국장",
            "currency": "USD" if key == "us" else "KRW",
            "indices": build_indices(key, stocks),
            "themes": build_themes(themes, stocks),
            "stocks": stocks,
            "errors": errors,
        }
        result["markets"][key] = mk
        print(f"  {key}: {len(stocks)}종목 성공 / {len(errors)}실패")

    # 달러/원
    fx = None
    for key in ("us", "kr"):
        for ix in result["markets"][key]["indices"]:
            if ix["symbol"] == "KRW=X":
                fx = ix["price"]
    result["meta"]["usd_krw"] = fx

    path = os.path.join(DATA_DIR, "stocks.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    total = sum(len(result["markets"][k]["stocks"]) for k in result["markets"])
    print(f"\n저장: {path} ({os.path.getsize(path)/1024:.0f}KB) · 총 {total}종목 · {time.time()-t0:.0f}초")
    errs = [e for k in result["markets"] for e in result["markets"][k]["errors"]]
    if errs:
        print("실패:", errs[:10])
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
