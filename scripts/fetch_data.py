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


def sma_series(vals, n):
    """각 시점의 n개 단순이동평균. 앞쪽 n-1개는 None."""
    out = []
    s = 0.0
    for i, v in enumerate(vals):
        s += v
        if i >= n:
            s -= vals[i - n]
        out.append(round(s / n, 6) if i >= n - 1 else None)
    return out


def stdev_series(vals, n):
    """각 시점 n개 표준편차(모집단). 앞쪽 n-1개는 None."""
    out = []
    for i in range(len(vals)):
        if i < n - 1:
            out.append(None)
            continue
        w = vals[i - n + 1:i + 1]
        m = sum(w) / n
        out.append(math.sqrt(sum((x - m) ** 2 for x in w) / n))
    return out


def bollinger_series(closes, n=20, k=2.0):
    """볼린저밴드(20일 · ±2 표준편차)."""
    mid = sma_series(closes, n)
    sd = stdev_series(closes, n)
    up, lo = [], []
    for m, s in zip(mid, sd):
        if m is None or s is None:
            up.append(None)
            lo.append(None)
        else:
            up.append(m + k * s)
            lo.append(m - k * s)
    return {"mid": mid, "upper": up, "lower": lo}


def cmf(highs, lows, closes, vols, n=20):
    """차이킨 자금흐름(CMF, n일). -1~+1, 음수면 매도 압력 우위."""
    if len(closes) < n:
        return None
    mfv = []
    for i in range(len(closes)):
        h, l, c, v = highs[i], lows[i], closes[i], vols[i] or 0
        if h is None or l is None or c is None:
            mfv.append(0.0)
            continue
        rng = h - l
        mfm = 0.0 if rng <= 0 else ((c - l) - (h - c)) / rng
        mfv.append(mfm * v)
    win_v = sum((vols[i] or 0) for i in range(len(vols) - n, len(vols)))
    if win_v <= 0:
        return None
    win_mfv = sum(mfv[len(mfv) - n:])
    return win_mfv / win_v


def rsi_state_of(rsi):
    """RSI 상태 배지 — 35 이하 과매도 반등권 / 35~45 눌림목 / 70 이상 과열."""
    if rsi is None:
        return "–", "na"
    if rsi <= 35:
        return "과매도 반등권", "oversold"
    if rsi <= 45:
        return "눌림목", "dip"
    if rsi >= 70:
        return "과열", "hot"
    return "중립", "neutral"


def bb_state_of(price, upper, lower):
    """최신 종가의 볼린저밴드 위치."""
    if not upper or not lower or upper <= lower:
        return "–", "na", None
    pct_b = (price - lower) / (upper - lower) * 100.0
    if price >= upper:
        return "상단 돌파 과열", "hot", pct_b
    if price <= lower * 1.02:
        return "하단 근접 반등", "cold", pct_b
    return "밴드 내", "mid", pct_b


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


def rsi_series(closes, period=14):
    """Wilder RSI(14) 전 구간 시리즈 — 차트용.

    앞 period개는 기준값이 없으므로 None, 이후는 소수 1자리 반올림 값.
    마지막 값은 rsi_wilder() 결과와 같다(차트 요약 수치와 일치).
    """
    n = len(closes)
    out = [None] * n
    if n < period + 1:
        return out

    def _val(avg_g, avg_l):
        if avg_l == 0:
            return 100.0
        return 100.0 - (100.0 / (1.0 + avg_g / avg_l))

    gains = 0.0
    losses = 0.0
    for i in range(1, period + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0.0)
        losses += max(-d, 0.0)
    avg_g = gains / period
    avg_l = losses / period
    out[period] = round(_val(avg_g, avg_l), 1)
    for i in range(period + 1, n):
        d = closes[i] - closes[i - 1]
        avg_g = (avg_g * (period - 1) + max(d, 0.0)) / period
        avg_l = (avg_l * (period - 1) + max(-d, 0.0)) / period
        out[i] = round(_val(avg_g, avg_l), 1)
    return out


def recent_vol_ratios(vols, lookback=5):
    """최근 거래일별 거래량 배수(직전 20일 평균 대비). [0]=오늘, [1]=어제 …

    주황 막대(2.0배 이상)가 최근 3거래일 안에 있었는지 판정할 때 쓴다.
    """
    out = []
    n = len(vols)
    for back in range(lookback):
        i = n - 1 - back
        if i < 0 or not vols[i]:
            out.append(None)
            continue
        prev = [v for v in vols[max(0, i - 20):i] if v]
        if len(prev) < 10:
            out.append(None)
            continue
        avg = sum(prev) / len(prev)
        out.append(round(vols[i] / avg, 2) if avg else None)
    return out


def ma200_break_ago(closes, opens, ma200s, lookback=3):
    """200일선을 음봉으로 깨고 내려간 날이 최근 lookback거래일 안에 있는지.

    반환: 0=오늘, 1=어제, 2=그제, 없으면 None.
    조건: 종가 < 200일선(0.5% 여유) · 음봉 · 전일 종가는 200일선 위.
    """
    n = len(closes)
    for back in range(lookback):
        i = n - 1 - back
        if i < 1 or ma200s[i] is None:
            continue
        if closes[i] < ma200s[i] * 0.995 and opens[i] > closes[i] and closes[i - 1] >= ma200s[i]:
            return back
    return None


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

    # 볼린저밴드 (20일 ±2 표준편차)
    bb = bollinger_series(closes, 20, 2.0)
    bb_up, bb_mid, bb_lo = bb["upper"][-1], bb["mid"][-1], bb["lower"][-1]
    bb_pos, bb_key, bb_pct_b = bb_state_of(price, bb_up, bb_lo)

    # 차이킨 자금흐름 (20일)
    cmf20 = cmf(highs, lows, closes, vols, 20)

    # 가짜 상승 경고: 윗꼬리 + 거래량, 또는 5일 상승 + CMF 음수
    reasons = []
    body = (closes[-1] - opens[-1]) if opens else 0.0
    upper_wick = (highs[-1] - closes[-1]) if highs else 0.0
    wick_ratio = (upper_wick / body) if body > 0 else None
    if body > 0 and wick_ratio is not None and wick_ratio > 1.2 and vol_ratio is not None and vol_ratio >= 1.5:
        reasons.append({
            "key": "upper_wick",
            "label": "매물 출회 의심",
            "detail": (f"양봉이지만 윗꼬리가 몸통의 {wick_ratio:.1f}배 · 거래량 20일 평균의 {vol_ratio:.1f}배 "
                       "— 위에서 파는 물량이 나온 모양"),
        })
    chg5 = None
    if len(closes) >= 6 and closes[-6]:
        chg5 = (closes[-1] / closes[-6] - 1) * 100.0
    if chg5 is not None and chg5 > 0 and cmf20 is not None and cmf20 < -0.05:
        reasons.append({
            "key": "cmf",
            "label": "자금유입 약함",
            "detail": (f"최근 5일 {chg5:+.1f}% 올랐지만 CMF(20일) {cmf20:.2f} — "
                       "가격은 올라도 자금은 빠지는 중"),
        })

    rsi_txt, rsi_key = rsi_state_of(rsi)

    # 최근 3거래일 거래량 배수 · 200일선 이탈 판정 (2대 공식용)
    vrec = recent_vol_ratios(vols, 5)
    v3 = [r for r in vrec[:3] if r is not None]
    vol_max3 = max(v3) if v3 else None
    vol_spike_days = [i for i, r in enumerate(vrec[:3]) if r is not None and r >= 2.0]
    ma200s = sma_series(closes, 200)
    break_ago = ma200_break_ago(closes, opens, ma200s, 3)

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
        "vol_avg20": round(avg_vol, 0) if avg_vol else None,
        "vol_spike": bool(vol_ratio is not None and vol_ratio >= 2.0),
        "candle": "양봉" if opens and closes[-1] >= opens[-1] else "음봉",
        "bb_upper": round(bb_up, 4) if bb_up is not None else None,
        "bb_mid": round(bb_mid, 4) if bb_mid is not None else None,
        "bb_lower": round(bb_lo, 4) if bb_lo is not None else None,
        "bb_pos": bb_pos,
        "bb_pos_key": bb_key,
        "bb_pct_b": round(bb_pct_b, 1) if bb_pct_b is not None else None,
        "cmf20": round(cmf20, 3) if cmf20 is not None else None,
        "chg5": round(chg5, 2) if chg5 is not None else None,
        "upper_wick_ratio": round(wick_ratio, 2) if wick_ratio is not None else None,
        "fake_rally_warn": bool(reasons),
        "fake_rally_reasons": reasons,
        "fake_rally_note": " · ".join(r["detail"] for r in reasons),
        "rsi_state": rsi_txt,
        "rsi_state_key": rsi_key,
        "vol_ratio_recent": vrec[:3],
        "vol_max3": round(vol_max3, 2) if vol_max3 is not None else None,
        "vol_spike_days": vol_spike_days,
        "vol_spike_3d": bool(vol_spike_days),
        "ma200_break": break_ago is not None,
        "ma200_break_ago": break_ago,
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


def formula_judge(d):
    """사용자가 직접 정한 2대 매매 공식 판정.

    ① 추세 타기 — 200일선 위 + 최근 3거래일 거래량 2배↑(주황 막대) + 200일선 지지·안착.
       200일선을 음봉으로 깨고 내려온 종목은 제외하고 "200일선 이탈 · 관망"으로 구분.
    ② 바닥 반등 단타 — 200일선 아래 + RSI(14) <= 38 + 볼린저 하단 근접/%B <= 20
       + 거래량 급증(2배↑, 근접 1.8배). 완전 일치("딱 맞음")와 대기 상태를 나누고
       매도 기준은 각 종목의 200일선 가격.
    """
    price, ma200, rsi = d["price"], d["ma200"], d["rsi14"]
    bb_lo, pctb = d.get("bb_lower"), d.get("bb_pct_b")
    vol_max3 = d.get("vol_max3")
    days = d.get("vol_spike_days") or []
    vr = d.get("vol_ratio")
    bong = d.get("candle") == "양봉"
    above = bool(ma200 and price >= ma200 * 0.995)
    below = bool(ma200 and price < ma200)
    brk = bool(d.get("ma200_break"))
    vol1 = bool(d.get("vol_spike_3d"))
    vol_near = bool(vol_max3 is not None and vol_max3 >= 1.8)
    dist = round((price / ma200 - 1) * 100, 1) if ma200 else None

    def ago_txt(i):
        return "오늘" if i == 0 else (f"{i}거래일 전" if i else "오늘")

    vol_detail = (f"최근 3거래일 최대 {vol_max3}배" + (f" ({ago_txt(days[0])} 주황 막대)" if days else "")) \
        if vol_max3 is not None else "거래량 데이터 부족"
    ma200_detail = (f"200일선 대비 +{dist}% 위" if (above and dist is not None) else
                    (f"200일선 대비 {dist}% 아래" if dist is not None else "200일선 계산 불가"))

    # ---------------- 공식 ① 추세 타기
    if not ma200:
        f1_key, f1_state = "none", "계산 불가"
        f1_note = "상장 기간이 짧아 200일선을 계산할 수 없습니다."
    elif brk:
        ago = d.get("ma200_break_ago")
        f1_key, f1_state = "out", "200일선 이탈 · 관망"
        f1_note = ("200일선을 음봉으로 깨고 내려왔어요"
                   + (f" ({ago_txt(ago)}) — " if ago is not None else " — ")
                   + "떨어지는 칼날 구간이라 바로 사지 않습니다. 양봉으로 200일선 위에 다시 올라탈 때까지 기다리세요.")
    elif above and vol1 and bong:
        f1_key, f1_state = "hit", "딱 맞음 · 지지 확인"
        f1_note = "200일선 위에서 거래량 2배↑가 나오고 오늘 양봉 — 추세 타기 자리입니다."
    elif above and vol1 and not bong:
        f1_key, f1_state = "wait", "양봉 대기"
        f1_note = "거래량은 터졌지만 오늘 음봉 — 양봉으로 막아서는 날 확인하고 들어가세요."
    elif above and vol_near:
        f1_key, f1_state = "wait", "거래량 2배 대기"
        f1_note = f"200일선 위에서 지지 중이지만 거래량이 {vol_max3}배 — 2배 이상 터지는 날을 기다리세요."
    elif above:
        f1_key, f1_state = "wait", "거래량 대기"
        f1_note = "200일선 위에서 지지 중 — 거래량이 실리는 날을 기다리세요."
    elif below and dist is not None and dist > -3:
        f1_key, f1_state = "near", "200일선 아래 · 지지 대기"
        f1_note = f"200일선 바로 아래({dist}%) — 양봉으로 200일선 위에 올라타는지 지켜보세요."
    else:
        f1_key, f1_state = "none", "해당 없음"
        f1_note = (f"200일선 대비 {dist}% — 추세 타기 구간이 아닙니다." if dist is not None
                   else "200일선 데이터 부족")

    f1_checks = [
        {"key": "ma200", "label": "200일선 위", "ok": bool(above), "detail": ma200_detail},
        {"key": "volume", "label": "거래량 2배↑(3일)", "ok": vol1, "detail": vol_detail},
        {"key": "candle", "label": "양봉 지지", "ok": bool(bong), "detail": f"오늘 {d.get('candle')}"},
        {"key": "hold", "label": "이탈 아님", "ok": not brk,
         "detail": ("200일선 위 유지" if (not brk and above) else
                    ("200일선 아래 — 200일선을 깬 음봉은 아님" if not brk else
                     "최근 3거래일 안에 200일선을 음봉으로 이탈"))},
    ]

    # ---------------- 공식 ② 바닥 반등 단타
    rsi_ok = bool(rsi is not None and rsi <= 38)
    bb_ok = bool((pctb is not None and pctb <= 20) or (bb_lo and price <= bb_lo * 1.03))
    hit2 = vol1
    vol2_ok = bool(vol1 or vol_near)
    cnt = sum([below, rsi_ok, bb_ok, hit2])
    bb_detail = (f"%B {pctb} · 하단 {bb_lo:,.2f}" if pctb is not None and bb_lo else "볼린저 데이터 부족")
    rsi_detail = (f"RSI {rsi} — 38 이하" if rsi_ok else f"RSI {rsi if rsi is not None else '–'} — 38 초과") \
        if rsi is not None else "RSI 계산 불가"
    if below and rsi_ok and bb_ok and hit2:
        f2_key, f2_state = "hit", "딱 맞음 · 4개 동시"
        f2_note = "200일선 아래 · RSI 38 이하 · 볼린저 하단 · 거래량 2배↑ — 4개가 같은 날 겹쳤습니다. 반등 시 200일선을 매도 목표로 보세요."
    elif below and rsi_ok and bb_ok:
        f2_key, f2_state = "wait", "거래량 대기"
        f2_note = (f"싸진 자리(RSI {rsi} · 볼린저 하단)는 맞는데 거래량이 {vol_max3 if vol_max3 is not None else '–'}배 — "
                   "2배↑ 주황 막대가 터지는 날이 진입 자리입니다.")
    elif below and bb_ok and hit2 and not rsi_ok:
        f2_key, f2_state = "wait", "RSI 대기"
        f2_note = f"볼린저 하단 + 거래량은 왔지만 RSI {rsi} — 38 이하로 식으면 다시 보세요."
    elif below and rsi_ok and hit2 and not bb_ok:
        f2_key, f2_state = "wait", "볼린저 대기"
        f2_note = "RSI·거래량은 왔지만 볼린저 하단까지 밀리지 않았습니다 — 조금 더 눌림을 기다리세요."
    elif below and cnt >= 2:
        f2_key, f2_state = "near", f"근접 {cnt}/4"
        f2_note = "조건 일부만 맞았습니다 — 4개가 겹치는 날 다시 확인하세요."
    else:
        f2_key, f2_state = "none", "해당 없음"
        f2_note = ("200일선 위 — 바닥 반등 구간이 아닙니다." if (ma200 and not below) else
                   (f"조건 {cnt}/4 — 아직 아닙니다." if ma200 else "200일선 데이터 부족"))

    f2_checks = [
        {"key": "ma200", "label": "200일선 아래", "ok": bool(below), "detail": ma200_detail},
        {"key": "rsi", "label": "RSI 38 이하", "ok": rsi_ok, "detail": rsi_detail},
        {"key": "bb", "label": "볼린저 하단", "ok": bb_ok,
         "detail": (bb_detail + (" · 하단 근접" if bb_ok else " · 밴드 안쪽") if pctb is not None else "볼린저 데이터 부족")},
        {"key": "volume", "label": "거래량 2배↑", "ok": hit2, "detail": vol_detail},
    ]

    sell = {
        "ma200": round(ma200, 4) if ma200 else None,
        "dist_pct": dist,
        "note": "반등 시 200일선 근처 매도",
    }
    return {
        "f1": {"state": f1_state, "key": f1_key, "note": f1_note,
               "above": above, "below": below, "break": brk, "vol_ok": vol1,
               "vol_max3": vol_max3, "count": sum(1 for c in f1_checks if c["ok"]),
               "checks": f1_checks, "sell": sell},
        "f2": {"state": f2_state, "key": f2_key, "note": f2_note,
               "above": above, "below": below, "vol_ok": hit2, "vol_near": vol2_ok,
               "vol_max3": vol_max3, "count": cnt,
               "checks": f2_checks, "sell": sell},
    }


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
    # 마지막 봉의 종가가 비어 있을 때(야후 일봉 지연) 현재가로 메우기
    meta = res.get("meta") or {}
    rmp, rmt = meta.get("regularMarketPrice"), meta.get("regularMarketTime")
    live_day = None
    if rmt:
        try:
            live_day = datetime.fromtimestamp(rmt, tz).strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001
            live_day = None
    for i, t in enumerate(ts):
        try:
            c = closes[i]
            if c is None:
                day = datetime.fromtimestamp(t, tz).strftime("%Y-%m-%d")
                if i == len(ts) - 1 and rmp and (live_day is None or live_day == day):
                    c = float(rmp)
                else:
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
    mapping = {"strong_buy": "적극 매수", "buy": "매수", "hold": "보유",
               "underperform": "비중 축소", "sell": "매도"}
    if rec_key in mapping:
        key_kr = mapping[rec_key]
    elif rec_mean:
        key_kr = ("적극 매수" if rec_mean <= 1.5 else
                  "매수" if rec_mean <= 2.5 else
                  "보유" if rec_mean <= 3.5 else "비중 축소")
    else:
        key_kr = "목표가만 집계"
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
    elif ma200 and price >= ma200 * 0.97:
        out["entry_note"] = "200일선 부근 — 골든존 분할 진입 가능 구간"
    elif ma200:
        out["entry_note"] = (f"200일선 아래({(price/ma200-1)*100:.1f}%) 하락 추세 — "
                             "반등(양봉·거래량) 확인 전에는 진입 금지, 관찰만")
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
            fm = formula_judge(d)
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
                "vol_ratio": d["vol_ratio"], "vol_avg20": d["vol_avg20"],
                "vol_spike": d["vol_spike"], "candle": d["candle"],
                "vol_ratio_recent": d["vol_ratio_recent"], "vol_max3": d["vol_max3"],
                "vol_spike_3d": d["vol_spike_3d"], "vol_spike_days": d["vol_spike_days"],
                "ma200_break": d["ma200_break"], "ma200_break_ago": d["ma200_break_ago"],
                "f1": fm["f1"], "f2": fm["f2"],
                "bb_upper": d["bb_upper"], "bb_mid": d["bb_mid"], "bb_lower": d["bb_lower"],
                "bb_pos": d["bb_pos"], "bb_pos_key": d["bb_pos_key"], "bb_pct_b": d["bb_pct_b"],
                "cmf20": d["cmf20"], "chg5": d["chg5"],
                "upper_wick_ratio": d["upper_wick_ratio"],
                "fake_rally_warn": d["fake_rally_warn"],
                "fake_rally_reasons": d["fake_rally_reasons"],
                "fake_rally_note": d["fake_rally_note"],
                "rsi_state": d["rsi_state"], "rsi_state_key": d["rsi_state_key"],
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
            # 볼린저밴드 시리즈 (일봉) — 앞쪽 19개는 null
            bbs = bollinger_series(dh["c"], 20, 2.0)
            for k, arr in (("bb_upper", bbs["upper"]), ("bb_mid", bbs["mid"]), ("bb_lower", bbs["lower"])):
                dh[k] = [round(v, digits) if v is not None else None for v in arr]
            # RSI(14) 시리즈 (일봉·주봉) — 차트 세 번째 패널용, 앞 14개 null
            dh["rsi14"] = rsi_series(dh["c"], 14)
            if wh.get("c"):
                wh["rsi14"] = rsi_series(wh["c"], 14)
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
