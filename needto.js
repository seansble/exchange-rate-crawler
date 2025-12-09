require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

// 🔑 Supabase 설정
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TARGET_CURRENCIES = ['USD', 'JPY', 'EUR', 'CNY', 'VND', 'THB'];

// ✈️ 인천공항 정밀 마진율
const AIRPORT_SPREADS = {
  WOORI: { 'USD': [0.042, 0.042], 'EUR': [0.045, 0.043], 'JPY': [0.045, 0.070], 'CNY': [0.118, 0.098], 'VND': [0.139, 0.169], 'THB': [0.1015, 0.100], 'DEFAULT': [0.08, 0.08] },
  HANA: { 'USD': [0.042, 0.042], 'EUR': [0.045, 0.042], 'JPY': [0.045, 0.070], 'CNY': [0.120, 0.100], 'VND': [0.170, 0.185], 'THB': [0.105, 0.100], 'DEFAULT': [0.08, 0.08] },
  KB: { 'USD': [0.0425, 0.0425], 'EUR': [0.045, 0.045], 'JPY': [0.045, 0.070], 'CNY': [0.120, 0.100], 'VND': [0.180, 0.180], 'THB': [0.110, 0.110], 'DEFAULT': [0.08, 0.08] }
};

// ============================================================
// 1. [KB국민은행] (GET)
// ============================================================
async function crawlKB() {
  const URL = 'https://obank.kbstar.com/quics?page=C101423&QSL=F';
  const results = [];
  try {
    const res = await axios.get(URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, responseType: 'arraybuffer' });
    const decoder = new TextDecoder('euc-kr');
    const html = decoder.decode(res.data);
    const $ = cheerio.load(html);
    $('#inqueryTable table.tType01 tbody tr').each((i, el) => {
      const tds = $(el).find('td');
      if (tds.length > 5) {
        let currency = $(tds[0]).text().trim();
        let name = $(tds[1]).text().trim();
        if (TARGET_CURRENCIES.includes(currency)) {
          let unit = name.includes('100') ? 100 : 1;
          let baseRate = parseFloat($(tds[2]).text().replace(/,/g, ''));
          let cashBuy = parseFloat($(tds[5]).text().replace(/,/g, ''));
          let cashSell = parseFloat($(tds[6])?.text()?.replace(/,/g, '') || 0);
          if(baseRate) results.push({ bank_code: 'KB', currency_code: currency, unit, cash_buy: cashBuy, cash_sell: cashSell, base_rate: baseRate, spread: parseFloat((cashBuy - baseRate).toFixed(2)) });
        }
      }
    });
  } catch (e) { console.error('❌ KB Fail:', e.message); }
  return results;
}

// ============================================================
// 2. [하나은행] (POST)
// ============================================================
async function crawlHana() {
  const URL = 'https://m.kebhana.com/m/inquiry/fxrate/msfxr_100_01.do';
  const results = [];
  try {
    const res = await axios.post(URL, 'requestTarget=HANA_MAIN_CONTENT', {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0)', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
    });
    const $ = cheerio.load(res.data);
    $('ul.currency_list li').each((i, el) => {
      const name = $(el).find('span.cntyNm').text().trim();
      const match = name.match(/^(.+?)\s+([A-Z]{3})(?:\s*\((\d+)\))?/);
      if (match) {
        let currency = match[2];
        let unit = match[3] ? parseInt(match[3]) : 1;
        if (TARGET_CURRENCIES.includes(currency)) {
          const getVal = (cls) => parseFloat($(el).find(cls).text().replace(/,/g, '') || 0);
          let baseRate = getVal('span.dealBascRt');
          if(baseRate) results.push({ bank_code: 'HANA', currency_code: currency, unit, cash_buy: getVal('span.acmnSllRt'), cash_sell: getVal('span.acmnBuyRt'), base_rate: baseRate, spread: parseFloat((getVal('span.acmnSllRt') - baseRate).toFixed(2)) });
        }
      }
    });
  } catch (e) { console.error('❌ Hana Fail:', e.message); }
  return results;
}

// ============================================================
// 3. [우리은행] (woori.js 원본 이식)
// ============================================================
const WOORI_LIST_URL = 'https://spot.wooribank.com/pot/Dream?withyou=CMCOM0184';
function makeWooriDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return { full: `${yyyy}${mm}${dd}`, dot: `${yyyy}.${mm}.${dd}`, y: String(yyyy), m: mm, d: dd };
}
async function getWooriSession() {
  try {
    const res = await axios.get(WOORI_LIST_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://spot.wooribank.com/',
      },
    });
    const setCookie = res.headers['set-cookie'] || [];
    const cookieHeader = setCookie.map((c) => c.split(';')[0]).join('; ');
    const html = res.data;
    let m = html.match(/jcc\?withyou=CMCOM0184[^"'&]*[&;]__ID=([a-zA-Z0-9]+)/) || html.match(/__ID=([a-zA-Z0-9]+)/);
    if (!m) m = html.match(/name=["']__ID["']\s+value=["']([^"']+)["']/i);
    if (!m) m = html.match(/__ID[^"'=]*=\s*["']([a-zA-Z0-9]+)["']/);
    if (!m) throw new Error('Woori ID Not Found');
    return { cookieHeader, id: m[1] };
  } catch(e) { return null; }
}
async function fetchWooriRates(dateObj, cookieHeader, id) {
  const { full, dot, y, m, d } = makeWooriDate(dateObj);
  const POST_URL = `https://spot.wooribank.com/pot/jcc?withyou=CMCOM0184&__ID=${id}`;
  const params = new URLSearchParams();
  params.append('BAS_DT_601', full); params.append('NTC_DIS', 'A'); params.append('SELECT_DATE_601', dot);
  params.append('SELECT_DATE_601Y', y); params.append('SELECT_DATE_601M', m); params.append('SELECT_DATE_601D', d);
  try {
    const res = await axios.post(POST_URL, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'Accept': 'text/html, */*; q=0.01',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'Origin': 'https://spot.wooribank.com',
        'Referer': WOORI_LIST_URL,
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookieHeader,
      },
    });
    const $ = cheerio.load(res.data);
    if (res.data.includes('고시되지 않았습니다')) return null;
    const results = [];
    $('table.tbl-type-1 tbody tr').each((i, el) => {
      const tds = $(el).find('td');
      if (tds.length > 8) {
        const currency = $(tds[0]).text().trim();
        const name = $(tds[1]).text().trim();
        if (TARGET_CURRENCIES.includes(currency)) {
          const unit = name.includes('100') ? 100 : 1;
          const cashBuy = parseFloat($(tds[4]).text().replace(/,/g, ''));
          const cashSell = parseFloat($(tds[6]).text().replace(/,/g, ''));
          const baseRate = parseFloat($(tds[8]).text().replace(/,/g, ''));
          if (baseRate > 0) {
            results.push({
              bank_code: 'WOORI', currency_code: currency, unit,
              cash_buy: cashBuy, cash_sell: cashSell, base_rate: baseRate,
              spread: parseFloat((cashBuy - baseRate).toFixed(2))
            });
          }
        }
      }
    });
    return results.length > 0 ? results : null;
  } catch (e) { return null; }
}
async function crawlWoori() {
  try {
    const session = await getWooriSession();
    if (!session) return [];
    const { cookieHeader, id } = session;
    let date = new Date();
    for (let i = 0; i < 7; i++) {
      const res = await fetchWooriRates(date, cookieHeader, id);
      if (res && res.length > 0) return res;
      date.setDate(date.getDate() - 1);
    }
  } catch (e) { console.error('❌ Woori Fail:', e.message); }
  return [];
}

// ============================================================
// 4. [신한은행] (Puppeteer) - sinhan.js 로직
// ============================================================
async function crawlShinhan() {
  const URL = "https://bank.shinhan.com/index.jsp#020501010000";
  const results = [];
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));
    const frames = page.frames();
    for (const frame of frames) {
      const data = await frame.evaluate(() => {
        const extracted = [];
        const targetCcy = ["USD", "JPY", "EUR", "CNY", "VND", "THB"];
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        rows.forEach(tr => {
          const tds = tr.querySelectorAll('td');
          if (tds.length > 8) {
            const name = tds[0].innerText.trim();
            const code = tds[1].innerText.trim();
            if (targetCcy.includes(code)) {
              const unit = name.includes('100') ? 100 : 1;
              const p = (t) => parseFloat(t.replace(/,/g, '')) || 0;
              const baseRate = p(tds[2].innerText);
              const cashSell = p(tds[5].innerText);
              const cashBuy = p(tds[7].innerText);
              if (baseRate > 0) extracted.push({ bank_code: 'SHINHAN', currency_code: code, unit, cash_buy: cashBuy, cash_sell: cashSell, base_rate: baseRate, spread: parseFloat((cashBuy - baseRate).toFixed(2)) });
            }
          }
        });
        return extracted.length > 0 ? extracted : null;
      });
      if (data) { results.push(...data); break; }
    }
  } catch (e) { console.error("❌ Shinhan Fail:", e.message); } 
  finally { if (browser) await browser.close(); }
  return results;
}

// ============================================================
// 5. [KB Star FX] 실시간 미드레이트 (토스/카카오용)
// ============================================================
async function crawlKBStarFX() {
  const URL = 'https://fx.kbstar.com/quics?asfilecode=1064403&QSL=F';
  const results = [];
  try {
    const res = await axios.post(URL, {}, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      }
    });
    
    const mergeList = res.data?.msg?.servicedata?.mergeList || [];
    
    // KB FX는 JPY가 100엔 기준
    const unitMap = { 'JPY': 100 };
    
    mergeList.forEach(item => {
      const currency = item.통화코드;
      // USD, EUR, JPY, CNY, THB만 (VND 없음)
      if (['USD', 'EUR', 'JPY', 'CNY', 'THB'].includes(currency)) {
        const baseRate = parseFloat(item.기준환율.replace(/,/g, ''));
        const unit = unitMap[currency] || 1;
        
        results.push({
          currency_code: currency,
          unit: unit,
          base_rate: baseRate,
          updated_at: item.기준년월일시
        });
      }
    });
    
    console.log(`✅ KB Star FX: ${results.length}개 통화 수집`);
  } catch (e) {
    console.error('❌ KB Star FX Fail:', e.message);
  }
  return results;
}

// ============================================================
// ⭐ MAIN
// ============================================================
async function runAll() {
  console.log("\n🚀 [Sudanghelp] 전체 수집 시작...\n");
  
  const [kb, hana, woori, shinhan, kbStarFX] = await Promise.all([
    crawlKB(), crawlHana(), crawlWoori(), crawlShinhan(), crawlKBStarFX()
  ]);
  console.log(`- KB:${kb.length}, 하나:${hana.length}, 우리:${woori.length}, 신한:${shinhan.length}, KB_FX:${kbStarFX.length}`);

  let finalData = [...kb, ...hana, ...woori, ...shinhan];

  // ============================================================
  // 핀테크
  // ============================================================
  
  // TOSS: KB Star FX 기반 (USD, EUR, JPY, CNY, THB) + 하나 VND
  if (kbStarFX.length > 0) {
    const toss = kbStarFX.map(item => ({
      bank_code: 'TOSS',
      currency_code: item.currency_code,
      unit: item.unit,
      base_rate: item.base_rate,
      cash_buy: item.base_rate,
      cash_sell: item.base_rate,
      spread: 0
    }));
    
    // VND는 하나은행에서 가져오기
    const hanaVND = hana.find(h => h.currency_code === 'VND');
    if (hanaVND) {
      toss.push({
        bank_code: 'TOSS',
        currency_code: 'VND',
        unit: hanaVND.unit,
        base_rate: hanaVND.base_rate,
        cash_buy: hanaVND.base_rate,
        cash_sell: hanaVND.base_rate,
        spread: 0
      });
    }
    
    finalData = [...finalData, ...toss];
  }

  // TRB, TRW: 기존 로직 유지 (하나 기반)
  if (hana.length > 0) {
    const trb = hana.map(item => ({ ...item, bank_code: 'TRB', spread: 0, cash_buy: item.base_rate, cash_sell: parseFloat((item.base_rate * 0.99).toFixed(2)) }));
    const trw = hana.map(item => {
      const isMajor = ['USD','JPY','EUR'].includes(item.currency_code);
      const buyMargin = isMajor ? 0 : 0.008; 
      return {
        ...item, bank_code: 'TRW',
        cash_buy: parseFloat((item.base_rate * (1 + buyMargin)).toFixed(2)),
        cash_sell: parseFloat((item.base_rate * 0.99).toFixed(2)),
        spread: parseFloat((item.base_rate * buyMargin).toFixed(2))
      };
    });
    finalData = [...finalData, ...trb, ...trw];
  }

  // KAKAO: KB Star FX USD만 사용
  if (kbStarFX.length > 0) {
    const kbUSD = kbStarFX.find(item => item.currency_code === 'USD');
    if (kbUSD) {
      finalData.push({
        bank_code: 'KAKAO',
        currency_code: 'USD',
        unit: 1,
        base_rate: kbUSD.base_rate,
        cash_buy: kbUSD.base_rate,
        cash_sell: kbUSD.base_rate,
        spread: 0
      });
    }
  }

  // ============================================================
  // 우리 환전주머니 & 신한 SOL 트래블
  // ============================================================
  
  // WOORI_POCKET: 우리은행 base_rate 기반 (6개 통화)
  if (woori.length > 0) {
    const wooriPocket = woori.map(item => ({
      ...item,
      bank_code: 'WOORI_POCKET',
      spread: 0,
      cash_buy: item.base_rate,
      cash_sell: item.base_rate
    }));
    finalData = [...finalData, ...wooriPocket];
  }

  // SOL_TRAVEL: 신한은행 base_rate 기반 (6개 통화)
  if (shinhan.length > 0) {
    const solTravel = shinhan.map(item => ({
      ...item,
      bank_code: 'SOL_TRAVEL',
      spread: 0,
      cash_buy: item.base_rate,
      cash_sell: item.base_rate
    }));
    finalData = [...finalData, ...solTravel];
  }

  // ============================================================
  // 공항 3대장
  // ============================================================
  const createAirportData = (source, bankName, config) => {
    return source.map(item => {
      const rates = config[item.currency_code] || config['DEFAULT'];
      const buyMargin = rates[0];
      const sellMargin = rates[1];
      return {
        ...item, bank_code: bankName, cash_buy: parseFloat((item.base_rate * (1 + buyMargin)).toFixed(2)), cash_sell: parseFloat((item.base_rate * (1 - sellMargin)).toFixed(2)),
        spread: parseFloat((item.base_rate * buyMargin).toFixed(2))
      };
    });
  };

  if (hana.length > 0) finalData = [...finalData, ...createAirportData(hana, 'AIR_HANA', AIRPORT_SPREADS.HANA)];
  if (woori.length > 0) finalData = [...finalData, ...createAirportData(woori, 'AIR_WOORI', AIRPORT_SPREADS.WOORI)];
  if (kb.length > 0) finalData = [...finalData, ...createAirportData(kb, 'AIR_KB', AIRPORT_SPREADS.KB)];

  // 🟢 [핵심] 한국 시간(KST) 생성 및 추가
  const now = new Date();
  const kstDate = new Date(now.getTime() + (9 * 60 * 60 * 1000)); // UTC + 9시간
  const kstString = kstDate.toISOString().replace('T', ' ').substring(0, 19); // "2025-12-03 10:30:00"
  
  finalData = finalData.map(item => ({
    ...item,
    kst_time: kstString
  }));

  console.log(`\n📊 [최종] 총 ${finalData.length}건 준비 완료. (시간: ${kstString})`);
  
  // 무조건 표 출력
  console.table(finalData);

  if (supabase) {
    const { error } = await supabase.from('exchange_rates').insert(finalData);
    if (error) console.error("🔥 DB 저장 실패:", error.message);
    else console.log("💾 [Success] Supabase DB 적재 완료!");
  } else {
    console.log("⚠️ DB 키 없음 (테스트 모드)");
  }
}

runAll();