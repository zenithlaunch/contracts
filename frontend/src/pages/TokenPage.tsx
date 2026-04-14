import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { ethers, formatUnits } from "ethers";
import { useAccount } from "wagmi";
import confetti from "canvas-confetti";
import { KAS_LAUNCH_ABI, LEGACY_KAS_LAUNCH_ABI } from "../abis/kasLaunch";
import { CONTRACT_ADDRESSES, LEGACY_KAS_LAUNCH, LEGACY_KAS_LAUNCH_DEPLOY_BLOCK, GRADUATION_KAS_THRESHOLD, EXPLORER_URL, buildSwapUrl, KASLAUNCH_DEPLOY_BLOCK } from "../constants/contracts";
import { ACTIVE_CHAIN } from "../constants/chains";
import { fmt } from "../utils/format";
import { useKasPrice } from "../utils/kasPrice";
import { fetchMetadata, ipfsToHttp, TokenMetadata } from "../utils/ipfs";
import { getReadProvider } from "../utils/provider";
import { isBlockedTrader } from "../constants/hiddenTraders";
import BuySellPanel from "../components/BuySellPanel";
import PriceChart, { TradePoint } from "../components/PriceChart";
import CommentSection from "../components/CommentSection";
import IpfsImage from "../components/IpfsImage";
import { addToken } from "../hooks/useRecentlyViewed";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import { getWalletBadge, WalletBadge } from "../utils/badges";

interface CurveData {
  tokenMint:            string;
  virtualTokenReserves: bigint;
  virtualKasReserves:   bigint;
  realTokenReserves:    bigint;
  realKasReserves:      bigint;
  tokenTotalSupply:     bigint;
  complete:             boolean;
  creator:              string;
  metadataUri:          string;
}

interface TradeRow {
  txHash:      string;
  isBuy:       boolean;
  kasAmount:   bigint;
  tokenAmount: bigint;
  trader:      string;
  timestamp:   number;
  price:       bigint;
}

async function chunkQuery(contract: ethers.Contract, filter: ethers.DeferredTopicFilter, fromBlock: number, toBlock: number): Promise<ethers.EventLog[]> {
  const CHUNK = 90_000;
  const out: ethers.EventLog[] = [];
  for (let f = fromBlock; f <= toBlock; f += CHUNK) {
    const chunk = await contract.queryFilter(filter, f, Math.min(f + CHUNK - 1, toBlock)) as ethers.EventLog[];
    out.push(...chunk);
  }
  return out;
}

function GraduationBanner({ kasLiquidity, tokenLiquidity, graduatedAt }: {
  kasLiquidity: bigint;
  tokenLiquidity: bigint;
  graduatedAt: number;
}) {
  return (
    <div className="rounded-2xl px-6 py-5 mb-6"
         style={{ background: "rgba(73,234,203,0.05)", border: "1px solid rgba(73,234,203,0.25)" }}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#49eacb" }} />
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: "#49eacb" }}>Graduated</span>
          </div>
          <h2 className="text-base font-bold text-white">
            {ACTIVE_CHAIN.testnet ? "Curve Complete" : "Trading on ZealousSwap DEX"}
          </h2>
          <p className="text-slate-500 text-sm mt-0.5">
            {ACTIVE_CHAIN.testnet
              ? "Curve complete. DEX handoff is mainnet-only — graduated tokens do not move to a live DEX on testnet."
              : "The bonding curve is closed. This token now trades on the open market."}
          </p>
        </div>
        {graduatedAt > 0 && (
          <div className="text-xs text-slate-600 shrink-0">{fmt.date(graduatedAt)}</div>
        )}
      </div>
      {!ACTIVE_CHAIN.testnet && kasLiquidity > 0n && (
        <div className="mt-4 pt-4 grid grid-cols-3 gap-3 text-xs border-t"
             style={{ borderColor: "rgba(73,234,203,0.12)" }}>
          <div>
            <div className="text-slate-600 mb-0.5">KAS seeded to pool</div>
            <div className="text-white font-semibold font-mono">{fmt.kas(kasLiquidity)} iKAS</div>
          </div>
          <div>
            <div className="text-slate-600 mb-0.5">Tokens seeded</div>
            <div className="text-white font-semibold font-mono">{fmt.token(tokenLiquidity)}</div>
          </div>
          <div>
            <div className="text-slate-600 mb-0.5">LP tokens</div>
            <div className="font-semibold" style={{ color: "#49eacb" }}>Burned forever</div>
          </div>
        </div>
      )}
    </div>
  );
}

function GraduatedDexPanel({ tokenAddress, tokenSymbol, tokenImage, dexPair, kasLiquidity }: {
  tokenAddress: string;
  tokenSymbol?: string;
  tokenImage?: string;
  dexPair?: string;
  kasLiquidity: bigint;
}) {
  const [addedToWallet, setAddedToWallet] = useState(false);
  const isTestnet = ACTIVE_CHAIN.testnet;
  const swapUrl   = buildSwapUrl(tokenAddress!);
  const pairUrl   = dexPair ? `${EXPLORER_URL}/address/${dexPair}` : "";

  async function handleAddToWallet() {
    try {
      await (window as any).ethereum?.request({
        method: "wallet_watchAsset",
        params: {
          type: "ERC20",
          options: {
            address:  tokenAddress,
            symbol:   tokenSymbol || "TOKEN",
            decimals: 18,
            image:    tokenImage ? ipfsToHttp(tokenImage) : undefined,
          },
        },
      });
      setAddedToWallet(true);
      setTimeout(() => setAddedToWallet(false), 3000);
    } catch {}
  }

  return (
    <div className="rounded-2xl overflow-hidden"
         style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(73,234,203,0.2)" }}>
      <div className="px-4 py-3 border-b"
           style={{ borderColor: "rgba(73,234,203,0.12)", background: "rgba(73,234,203,0.04)" }}>
        <div className="text-xs font-bold uppercase tracking-widest mb-0.5" style={{ color: "#49eacb" }}>Trading</div>
        <div className="text-sm font-semibold text-white">Bonding curve closed</div>
      </div>

      <div className="p-4 space-y-2.5">
        {isTestnet ? (
          <div className="rounded-xl px-4 py-3"
               style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
            <div className="text-xs font-semibold text-slate-400 mb-1">Testnet</div>
            <p className="text-xs text-slate-600 leading-relaxed">
              ZealousSwap is not deployed on testnet. DEX trading is only available on Igra Mainnet.
            </p>
          </div>
        ) : (
          <Link
            to={`/dex?token=${tokenAddress}`}
            className="flex items-center justify-between w-full px-4 py-3 rounded-xl font-semibold text-sm"
            style={{ background: "linear-gradient(135deg, rgba(73,234,203,0.1), rgba(20,184,166,0.05))", border: "1px solid rgba(73,234,203,0.25)", color: "#49eacb" }}>
            <span>Trade on DEX</span>
            <span>→</span>
          </Link>
        )}

        {!isTestnet && (pairUrl ? (
          <a href={pairUrl} target="_blank" rel="noopener noreferrer"
             className="flex items-center justify-between w-full px-4 py-3 rounded-xl text-sm transition-colors"
             style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", color: "#94a3b8" }}
             onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(73,234,203,0.2)"; e.currentTarget.style.color = "#e2e8f0"; }}
             onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "#94a3b8"; }}>
            <span>View pair on Explorer</span>
            <span>↗</span>
          </a>
        ) : (
          <div className="px-4 py-3 rounded-xl text-sm text-slate-700"
               style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
            Pair address loading…
          </div>
        ))}

        <button
          onClick={handleAddToWallet}
          className="flex items-center justify-between w-full px-4 py-3 rounded-xl text-sm transition-colors"
          style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: addedToWallet ? "#49eacb" : "#94a3b8",
          }}
          onMouseEnter={e => { if (!addedToWallet) { e.currentTarget.style.borderColor = "rgba(73,234,203,0.2)"; e.currentTarget.style.color = "#e2e8f0"; }}}
          onMouseLeave={e => { if (!addedToWallet) { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "#94a3b8"; }}}
        >
          <span>{addedToWallet ? "Added to wallet ✓" : "Add to wallet"}</span>
          {!addedToWallet && <span className="text-xs text-slate-700">EIP-747</span>}
        </button>

        {kasLiquidity > 0n && (
          <p className="text-xs text-slate-700 text-center pt-1">
            {fmt.kas(kasLiquidity)} iKAS seeded · LP permanently burned
          </p>
        )}
      </div>
    </div>
  );
}

function CurveCompletePanel() {
  return (
    <div className="rounded-2xl overflow-hidden"
         style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(73,234,203,0.2)" }}>
      <div className="px-4 py-3 border-b"
           style={{ borderColor: "rgba(73,234,203,0.12)", background: "rgba(73,234,203,0.04)" }}>
        <div className="text-xs font-bold uppercase tracking-widest mb-0.5" style={{ color: "#49eacb" }}>Status</div>
        <div className="text-sm font-semibold text-white">Curve Complete</div>
      </div>
      <div className="p-4">
        <p className="text-sm text-slate-500 leading-relaxed">
          Curve complete. DEX handoff is mainnet-only — graduated tokens do not move to a live DEX on testnet.
        </p>
      </div>
    </div>
  );
}

function LegacyTokenBanner() {
  return (
    <div className="rounded-2xl px-5 py-4 mb-6 flex items-start gap-4"
         style={{ background: "rgba(148,163,184,0.05)", border: "1px solid rgba(148,163,184,0.2)" }}>
      <div className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-slate-500"
           style={{ background: "rgba(148,163,184,0.1)" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
      </div>
      <div>
        <div className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-1">Legacy Token — Read Only</div>
        <p className="text-sm text-slate-500 leading-relaxed">
          This token was created on the original testnet contract. Graduation was not achievable on that contract due to a design flaw. Trading is disabled on this page.{" "}
          <Link to="/legacy" className="text-kas-400 hover:underline">View all legacy tokens →</Link>
        </p>
      </div>
    </div>
  );
}

export default function TokenPage() {
  const { address } = useParams<{ address: string }>();
  const { address: walletAddr } = useAccount();

  const [curve,    setCurve]    = useState<CurveData | null>(null);
  const [meta,     setMeta]     = useState<TokenMetadata | null>(null);
  const [trades,   setTrades]   = useState<TradeRow[]>([]);
  const [charts,   setCharts]   = useState<TradePoint[]>([]);
  const [mcap,     setMcap]     = useState(0n);
  const [price,    setPrice]    = useState(0n);
  const kasPrice = useKasPrice();
  const [dexPair,          setDexPair]          = useState<string | undefined>();
  const [dexKasLiquidity,  setDexKasLiquidity]  = useState<bigint>(0n);
  const [dexTokenLiquidity,setDexTokenLiquidity]= useState<bigint>(0n);
  const [dexGraduatedAt,   setDexGraduatedAt]   = useState<number>(0);
  const [loading,      setLoading]      = useState(true);
  const [rpcError,     setRpcError]     = useState(false);
  const [refreshing,   setRefreshing]   = useState(false);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [holderCount,  setHolderCount]  = useState<number>(0);
  const [holders,      setHolders]      = useState<{address: string; balance: bigint}[]>([]);
  const [copied,       setCopied]       = useState(false);
  const [addrCopied,   setAddrCopied]   = useState(false);
  const [badges,       setBadges]       = useState<Map<string, WalletBadge | null>>(new Map());
  const [isLegacy,         setIsLegacy]         = useState(false);
  const [kasLaunchAddress, setKasLaunchAddress] = useState(CONTRACT_ADDRESSES.KasLaunch);
  const contractRef    = useRef<ethers.Contract | null>(null);
  const deployBlockRef = useRef<number>(KASLAUNCH_DEPLOY_BLOCK);
  const walletRef      = useRef<string | undefined>(undefined);
  const prevComplete   = useRef<boolean | null>(null);
  walletRef.current    = walletAddr;

  const { active: ptrActive, spinning: ptrSpinning, enabled: ptrEnabled } = usePullToRefresh(async () => { await load(true); });

  async function load(silent = false) {
    if (!address || !CONTRACT_ADDRESSES.KasLaunch) return;
    if (silent) setRefreshing(true);
    else { setLoading(true); setRpcError(false); }

    try {
      const provider = getReadProvider();
      const ZERO = "0x0000000000000000000000000000000000000000";

      // Try new contract first, fallback to legacy if token not found there
      let contract = new ethers.Contract(CONTRACT_ADDRESSES.KasLaunch, KAS_LAUNCH_ABI, provider);
      let useLegacy = false;
      let deployBlock = KASLAUNCH_DEPLOY_BLOCK;

      // ── Phase 1: Curve + price — show UI immediately ──────────────
      let c: CurveData | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
        const result = await contract.getBondingCurve(address);
        if (result.tokenMint && result.tokenMint !== ZERO) { c = result; break; }
        // After first failed attempt on new contract, try legacy
        if (attempt === 0) {
          const legacyContract = new ethers.Contract(LEGACY_KAS_LAUNCH, LEGACY_KAS_LAUNCH_ABI, provider);
          const legacyResult = await legacyContract.getBondingCurve(address).catch(() => null);
          if (legacyResult?.tokenMint && legacyResult.tokenMint !== ZERO) {
            contract = legacyContract;
            useLegacy = true;
            deployBlock = LEGACY_KAS_LAUNCH_DEPLOY_BLOCK;
            c = legacyResult;
            break;
          }
        }
      }
      contractRef.current  = contract;
      deployBlockRef.current = deployBlock;
      if (useLegacy !== isLegacy) setIsLegacy(useLegacy);
      if (useLegacy) setKasLaunchAddress(LEGACY_KAS_LAUNCH);
      else setKasLaunchAddress(CONTRACT_ADDRESSES.KasLaunch);

      if (!c) { setLoading(false); setRefreshing(false); return; }

      const [p, m, currentBlock] = await Promise.all([contract.getPrice(address), contract.getMarketCap(address), provider.getBlockNumber()]);
      setCurve({
        tokenMint:            c.tokenMint,
        virtualTokenReserves: c.virtualTokenReserves,
        virtualKasReserves:   c.virtualKasReserves,
        realTokenReserves:    c.realTokenReserves,
        realKasReserves:      c.realKasReserves,
        tokenTotalSupply:     c.tokenTotalSupply,
        complete:             c.complete,
        creator:              c.creator,
        metadataUri:          c.metadataUri,
      });
      setPrice(p);
      setMcap(m);

      // UI is ready — stop blocking spinner
      setLoading(false);
      setRefreshing(false);

      // ── Phase 2: Background loads — parallel, non-blocking ────────
      const curveData = c;

      const tokenContract = new ethers.Contract(
        address,
        [
          "function balanceOf(address) view returns (uint256)",
          "function name() view returns (string)",
          "function symbol() view returns (string)",
          "event Transfer(address indexed from, address indexed to, uint256 value)"
        ],
        provider
      );

      // User balance
      if (walletAddr) {
        tokenContract.balanceOf(walletAddr)
          .then((bal: bigint) => setTokenBalance(bal))
          .catch(() => setTokenBalance(null));
      }

      // Trades + chart
      chunkQuery(contract, contract.filters.Trade(address), deployBlock, currentBlock)
        .then((events) => {
          const rows: TradeRow[] = (events as ethers.EventLog[])
            .filter((e) => e.args && e.args.length >= 9 && !isBlockedTrader(String(e.args[4])))
            .map((log) => {
              const [,kas,tok,isBuy,trader,ts,,, priceVal] = log.args as unknown as
                [string,bigint,bigint,boolean,string,bigint,bigint,bigint,bigint];
              return {
                txHash:      log.transactionHash,
                isBuy:       Boolean(isBuy),
                kasAmount:   BigInt(kas ?? 0n),
                tokenAmount: BigInt(tok ?? 0n),
                trader:      String(trader),
                timestamp:   Number(ts),
                price:       BigInt(priceVal ?? 0n),
              };
            });
          setTrades(rows.slice().reverse());
          setCharts(rows.map((r) => ({
            time:   r.timestamp,
            price:  Number(formatUnits(r.price, 18)),
            volume: Number(formatUnits(r.kasAmount, 18)),
          })));
        })
        .catch((e) => console.warn("Trade event fetch failed:", e));

      // Metadata — IPFS with ERC20 fallback
      (async () => {
        let ipfsOk = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const metadata = await fetchMetadata(curveData.metadataUri);
            setMeta(metadata);
            if (address) addToken(address, metadata.name, metadata.symbol, metadata.image || "");
            ipfsOk = true;
            break;
          } catch {
            if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
          }
        }
        if (!ipfsOk) {
          try {
            const [n, s] = await Promise.all([
              tokenContract.name().catch(() => ""),
              tokenContract.symbol().catch(() => ""),
            ]);
            if (n || s) {
              const fallback = { name: n || "Unknown", symbol: s || "???", description: "", image: "" };
              setMeta(fallback as TokenMetadata);
              if (address && n) addToken(address, n, s, "");
            }
          } catch {}
        }
      })();

      // Graduation check — fetch dexPair + liquidity amounts from Graduated event
      // Legacy contract: Graduated(token, pairAddress) — 2 args
      // New contract:    Graduated(token, pairAddress, kasLiquidity, tokenLiquidity, timestamp) — 5 args
      chunkQuery(contract, contract.filters.Graduated(address), deployBlock, currentBlock)
        .then((gradEvents) => {
          if (gradEvents.length > 0) {
            const log = gradEvents[0] as ethers.EventLog;
            setDexPair(log.args[1] as string);
            if (useLegacy) {
              setDexKasLiquidity(0n);
              setDexTokenLiquidity(0n);
              setDexGraduatedAt(0);
            } else {
              setDexKasLiquidity(log.args[2] as bigint);
              setDexTokenLiquidity(log.args[3] as bigint);
              setDexGraduatedAt(Number(log.args[4]));
            }
          }
        })
        .catch(() => {});

      // ── Phase 3: Holders — lazy, capped at 10 balanceOf calls ─────
      chunkQuery(tokenContract, tokenContract.filters.Transfer(), deployBlock, currentBlock)
        .then(async (transfers) => {
          const uniqueAddrs = new Set<string>();
          for (const e of transfers as ethers.EventLog[]) {
            if (e.args?.to   && e.args.to   !== ZERO) uniqueAddrs.add((e.args.to   as string).toLowerCase());
            if (e.args?.from && e.args.from !== ZERO) uniqueAddrs.add((e.args.from as string).toLowerCase());
          }
          setHolderCount(uniqueAddrs.size);

          const addrsToCheck = Array.from(uniqueAddrs).slice(0, 10);
          const balances = await Promise.all(
            addrsToCheck.map(async (addr) => {
              try {
                const bal: bigint = await tokenContract.balanceOf(addr);
                return { address: addr, balance: bal };
              } catch { return { address: addr, balance: 0n }; }
            })
          );
          const sorted = balances
            .filter((h) => h.balance > 0n)
            .sort((a, b) => (b.balance > a.balance ? 1 : -1));
          setHolders(sorted);
        })
        .catch(() => {});

    } catch (err) {
      console.error("Token load error:", err);
      if (!silent) setRpcError(true);
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
  }, [address]);

  // Fire confetti when curve.complete transitions false → true
  useEffect(() => {
    if (curve === null) return;
    if (prevComplete.current === null) {
      prevComplete.current = curve.complete;
      return;
    }
    if (!prevComplete.current && curve.complete) {
      confetti({
        particleCount: 160,
        spread: 100,
        origin: { x: 0.5, y: 0.1 },
        colors: ["#49eacb", "#14b8a6", "#5eead4", "#ffffff"],
        startVelocity: 45,
        gravity: 0.8,
      });
    }
    prevComplete.current = curve.complete;
  }, [curve?.complete]);

  // Poll price + mcap + curve + balance + new trades every 5s
  useEffect(() => {
    if (!address || !CONTRACT_ADDRESSES.KasLaunch) return;
    const provider = getReadProvider();
    // Use the contract already resolved by load() — handles both V2 and legacy correctly.
    // contractRef.current is null briefly before the first load() completes; poll skips safely.
    const contract = contractRef.current;
    const tokenContract = new ethers.Contract(address, [
      "function balanceOf(address) view returns (uint256)",
    ], provider);

    let lastTradeCount = 0;

    const poll = async () => {
      const c0 = contractRef.current;
      if (!c0) return;
      try {
        const [p, m, c] = await Promise.all([
          c0.getPrice(address),
          c0.getMarketCap(address),
          c0.getBondingCurve(address),
        ]);
        if (!c.complete) {
          setPrice(p);
          setMcap(m);
        }
        setCurve({
          tokenMint:            c.tokenMint,
          virtualTokenReserves: c.virtualTokenReserves,
          virtualKasReserves:   c.virtualKasReserves,
          realTokenReserves:    c.realTokenReserves,
          realKasReserves:      c.realKasReserves,
          tokenTotalSupply:     c.tokenTotalSupply,
          complete:             c.complete,
          creator:              c.creator,
          metadataUri:          c.metadataUri,
        });
      } catch { /* non-fatal */ }

      // Token balance aktualisieren
      try {
        if (walletRef.current) {
          const bal: bigint = await tokenContract.balanceOf(walletRef.current);
          setTokenBalance(bal);
        }
      } catch { /* non-fatal */ }

      // Neue Trades holen (letzte 20 Blöcke)
      try {
        const filter = c0.filters.Trade(address);
        const events = await c0.queryFilter(filter, -20);
        if (events.length > lastTradeCount) {
          lastTradeCount = events.length;
          const newRows = (events as ethers.EventLog[])
            .filter((e) => e.args && e.args.length >= 9)
            .map((log) => {
              const [, kas, tok, isBuy, trader, ts,,,priceVal] = log.args as unknown as
                [string,bigint,bigint,boolean,string,bigint,bigint,bigint,bigint];
              return {
                txHash:      log.transactionHash,
                isBuy:       Boolean(isBuy),
                kasAmount:   BigInt(kas ?? 0n),
                tokenAmount: BigInt(tok ?? 0n),
                trader:      String(trader),
                timestamp:   Number(ts),
                price:       BigInt(priceVal ?? 0n),
              };
            });
          setTrades((prev) => {
            const existingHashes = new Set(prev.map((t) => t.txHash));
            const added = newRows.filter((r) => !existingHashes.has(r.txHash));
            if (!added.length) return prev;
            return [...added.reverse(), ...prev].slice(0, 50);
          });
          setCharts((prev) => {
            const existingTimes = new Set(prev.map((t) => t.time));
            const added = newRows
              .filter((r) => r.timestamp > 0 && isFinite(r.timestamp) && !existingTimes.has(r.timestamp))
              .map((r) => ({ time: r.timestamp, price: Number(ethers.formatUnits(r.price, 18)), volume: Number(ethers.formatUnits(r.kasAmount, 18)) }));
            return added.length ? [...prev, ...added] : prev;
          });
        }
      } catch { /* non-fatal */ }
    };

    const id = setInterval(poll, 5000);

    // Holder-Rankings alle 30s aktualisieren (teurer Query)
    const holderPoll = async () => {
      try {
        const tc = new ethers.Contract(address!, [
          "function balanceOf(address) view returns (uint256)",
          "event Transfer(address indexed from, address indexed to, uint256 value)",
        ], provider);
        const ZERO = "0x0000000000000000000000000000000000000000";
        const latest = await provider.getBlockNumber();
        const transfers = await chunkQuery(tc, tc.filters.Transfer(), deployBlockRef.current, latest);
        const uniqueAddrs = new Set<string>();
        for (const e of transfers as ethers.EventLog[]) {
          if (e.args?.to   && e.args.to   !== ZERO) uniqueAddrs.add((e.args.to   as string).toLowerCase());
          if (e.args?.from && e.args.from !== ZERO) uniqueAddrs.add((e.args.from as string).toLowerCase());
        }
        setHolderCount(uniqueAddrs.size);
        const addrsToCheck = Array.from(uniqueAddrs).slice(0, 30);
        const balances = await Promise.all(
          addrsToCheck.map(async (a) => {
            try { return { address: a, balance: await tc.balanceOf(a) as bigint }; }
            catch { return { address: a, balance: 0n }; }
          })
        );
        const sorted = balances.filter((h) => h.balance > 0n).sort((a, b) => b.balance > a.balance ? 1 : -1);
        setHolders(sorted);
      } catch { /* non-fatal */ }
    };
    const holderId = setInterval(holderPoll, 30000);

    return () => { clearInterval(id); clearInterval(holderId); };
  }, [address]);


  // Fetch badges for all visible traders and holders
  useEffect(() => {
    const addrs = [
      ...new Set([
        ...trades.map(t => t.trader.toLowerCase()),
        ...holders.map(h => h.address.toLowerCase()),
      ])
    ].filter(a => a.startsWith("0x"));
    if (addrs.length === 0) return;
    Promise.all(addrs.map(async (addr) => {
      const badge = await getWalletBadge(addr);
      return [addr, badge] as [string, WalletBadge | null];
    })).then(results => {
      setBadges(prev => {
        let changed = false;
        const next = new Map(prev);
        for (const [addr, badge] of results) {
          if (!prev.has(addr)) { next.set(addr, badge); changed = true; }
        }
        return changed ? next : prev;
      });
    });
  }, [trades, holders]);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid md:grid-cols-3 gap-6">
          <div className="md:col-span-2 space-y-4">
            <div className="card h-80 animate-pulse" />
            <div className="card h-40 animate-pulse" />
          </div>
          <div className="card h-64 animate-pulse" />
        </div>
      </div>
    );
  }

  if (rpcError) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-24 text-center">
        <div className="text-4xl mb-4">⚡</div>
        <h2 className="text-xl font-bold text-white mb-2">Network unavailable</h2>
        <p className="text-slate-400 text-sm mb-6">The RPC is not responding right now. Please try again in a moment.</p>
        <button onClick={() => load()} className="btn-primary">Try again</button>
      </div>
    );
  }

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  if (!curve || !curve.tokenMint || curve.tokenMint === ZERO_ADDR) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-24 text-center">
        <div className="text-4xl mb-4">🔍</div>
        <h2 className="text-xl font-bold text-white mb-2">Token not found</h2>
        <p className="text-slate-400 text-sm mb-6">
          This address doesn't match any token on Zenith.
        </p>
        <Link to="/explore" className="btn-primary">Browse tokens</Link>
      </div>
    );
  }

  const realKas = curve.realKasReserves ?? 0n;
  const progress = fmt.progress(realKas, GRADUATION_KAS_THRESHOLD);
  const kasNeeded = realKas < GRADUATION_KAS_THRESHOLD ? GRADUATION_KAS_THRESHOLD - realKas : 0n;
  // Token has crossed the KAS raised threshold but graduation hasn't fired on-chain yet
  const gradPending = !curve.complete && realKas >= GRADUATION_KAS_THRESHOLD;

  return (
    <>
      {ptrEnabled && (
        <div className={`ptr-indicator ${(ptrActive || ptrSpinning) ? "ptr-visible" : ""}`}>
          <div className="ptr-spinner" />
        </div>
      )}
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Refresh indicator */}
      {refreshing && (
        <div className="fixed top-20 right-4 z-50 bg-kas-900 border border-kas-700 text-kas-300
                        text-xs px-3 py-1.5 rounded-full shadow-lg animate-pulse">
          Updating…
        </div>
      )}

      {/* Legacy banner — shown for all legacy tokens, replaces trade surface */}
      {isLegacy && <LegacyTokenBanner />}

      {/* Graduation banner — only for V2 tokens that are complete */}
      {curve.complete && !isLegacy && (
        <GraduationBanner
          kasLiquidity={dexKasLiquidity}
          tokenLiquidity={dexTokenLiquidity}
          graduatedAt={dexGraduatedAt}
        />
      )}

      <div className="grid md:grid-cols-3 gap-6">
        {/* Left: chart + trades */}
        <div className="md:col-span-2 space-y-5 order-last md:order-first">
          {/* Token header */}
          <div className="flex items-center gap-4">
            <IpfsImage
              hash={meta?.image || ""}
              fallbackSrc={`https://api.dicebear.com/7.x/shapes/svg?seed=${address}`}
              className="w-14 h-14 rounded-xl object-cover bg-dark-800"
              alt={meta?.name}
            />
            <div>
              <h1 className="font-display font-bold text-white" style={{ fontSize: "clamp(1.3rem, 3vw, 1.75rem)", letterSpacing: "-0.03em" }}>
                {meta?.name || "Unknown"}
                <span className="text-slate-500 text-lg font-normal ml-2">
                  ${meta?.symbol}
                </span>
              </h1>
              <div className="flex items-center gap-3 text-sm text-slate-500 mt-0.5">
                <Link to={`/profile/${curve.creator}`} className="hover:text-kas-400 transition-colors">
                  by {fmt.address(curve.creator, 4)}
                </Link>
                <a href={`${EXPLORER_URL}/address/${address}`}
                   target="_blank" rel="noopener noreferrer"
                   className="hover:text-kas-400">
                  {fmt.address(address!, 6)} ↗
                </a>
                {meta?.twitter && (
                  <a href={meta.twitter} target="_blank" rel="noopener noreferrer"
                     className="hover:text-kas-400">Twitter</a>
                )}
                {meta?.telegram && (
                  <a href={meta.telegram} target="_blank" rel="noopener noreferrer"
                     className="hover:text-kas-400">Telegram</a>
                )}
              </div>
            </div>
          </div>

          {/* Price stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="card text-center py-4">
              <div className="text-xs text-slate-500 mb-1">{curve.complete ? "Price at grad." : "Price"}</div>
              <div className="font-mono text-kas-400 font-bold">
                {curve.complete && price === 0n ? "—" : kasPrice ? fmt.usd(price, kasPrice) : `${fmt.kas(price, 8)} iKAS`}
              </div>
              {curve.complete && <div className="text-xs text-slate-700 mt-0.5">curve closed</div>}
            </div>
            <div className="card text-center py-4">
              <div className="text-xs text-slate-500 mb-1">{curve.complete ? "MCap at grad." : "Market Cap"}</div>
              <div className="font-bold text-white">
                {curve.complete && mcap === 0n ? "—" : kasPrice ? fmt.usd(mcap, kasPrice) : `${fmt.kas(mcap)} iKAS`}
              </div>
              {curve.complete && <div className="text-xs text-slate-700 mt-0.5">curve closed</div>}
            </div>
            <div className="card text-center py-4">
              <div className="text-xs text-slate-500 mb-1">
                {curve.complete ? (ACTIVE_CHAIN.testnet ? "KAS at close" : "LP Seeded") : "KAS Raised"}
              </div>
              <div className="font-bold text-white">
                {fmt.kas(curve.complete && !ACTIVE_CHAIN.testnet && dexKasLiquidity > 0n ? dexKasLiquidity : curve.realKasReserves)} iKAS
              </div>
              {curve.complete && !ACTIVE_CHAIN.testnet && dexKasLiquidity > 0n && <div className="text-xs text-slate-700 mt-0.5">post-fee, to DEX</div>}
            </div>
          </div>

          {/* Chart */}
          <div className="card p-4">
            <div className="text-sm font-semibold text-slate-400 mb-3">
              {curve.complete ? "Bonding Curve History" : "Price History (KAS)"}
            </div>
            <PriceChart trades={charts} />
          </div>

          {/* Graduation progress */}
          {!curve.complete && (
            <div className="card">
              {gradPending ? (
                <>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-kas-400 font-medium">Graduation Progress</span>
                    <span className="text-kas-400 font-medium">100%</span>
                  </div>
                  <div className="progress-bar mb-2">
                    <div className="progress-fill" style={{ width: "100%" }} />
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">{fmt.kas(mcap)} iKAS mcap</span>
                    <span className="text-kas-400 font-medium">Graduation pending</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-slate-400">Graduation Progress</span>
                    <span className="text-kas-400 font-medium">{progress}%</span>
                  </div>
                  <div className="progress-bar mb-2">
                    <div className={`progress-fill${progress >= 80 ? " progress-fill-hot" : ""}`} style={{ width: `${progress}%` }} />
                  </div>
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>{fmt.kas(mcap)} iKAS mcap</span>
                    <span>{fmt.kas(kasNeeded)} iKAS to graduation</span>
                  </div>
                </>
              )}
              <div className="text-xs text-slate-700 mt-2">
                Graduation is based on KAS raised, not remaining token inventory.
              </div>
            </div>
          )}

          {/* Recent trades */}
          <div className="card">
            <h3 className="font-semibold text-white mb-3">Recent Trades</h3>
            {trades.length === 0 ? (
              <p className="text-slate-600 text-sm text-center py-4">No trades yet.</p>
            ) : (
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {trades.slice(0, 30).map((t, i) => (
                  <div key={`${t.txHash}-${i}`}
                    className="flex items-center gap-3 text-xs px-2 py-1.5 rounded-lg
                               hover:bg-dark-800 transition-colors"
                  >
                    <span className={`font-bold w-7 ${t.isBuy ? "text-kas-400" : "text-red-400"}`}>
                      {t.isBuy ? "BUY" : "SELL"}
                    </span>
                    <span className="flex items-center gap-1 text-slate-400">
                      {badges.get(t.trader.toLowerCase())?.emoji && (
                        <span title={badges.get(t.trader.toLowerCase())!.label}>
                          {badges.get(t.trader.toLowerCase())!.emoji}
                        </span>
                      )}
                      {fmt.address(t.trader, 4)}
                    </span>
                    <span className="text-kas-400 font-mono">{fmt.kas(t.kasAmount, 3)} iKAS</span>
                    <span className="text-slate-500">for</span>
                    <span className="text-white font-mono">{fmt.token(t.tokenAmount)}</span>
                    <span className="text-slate-600 ml-auto">{fmt.date(t.timestamp)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Top Holders */}
          {holders.length > 0 && (
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-white">Top Holders</h3>
                <span className="text-xs px-2 py-1 rounded-lg text-slate-500"
                      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}>
                  {holderCount} holders
                </span>
              </div>
              <div className="space-y-2">
                {(() => {
                  let holderRank = 0;
                  return holders.slice(0, 10).map((h) => {
                    const pct = Number((h.balance * 10000n) / (1_000_000_000n * 10n**18n)) / 100;
                    const isYou          = h.address.toLowerCase() === walletAddr?.toLowerCase();
                    const isBondingCurve = h.address.toLowerCase() === CONTRACT_ADDRESSES.KasLaunch.toLowerCase();

                    if (!isBondingCurve) holderRank++;
                    const rank  = isBondingCurve ? null : holderRank;
                    const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null;

                    const barColor = isBondingCurve
                      ? "rgba(99,102,241,0.4)"
                      : isYou
                      ? "rgba(73,234,203,0.8)"
                      : rank === 1 ? "rgba(255,215,0,0.6)" : "rgba(73,234,203,0.35)";

                    return (
                      <div key={h.address}
                           className="group rounded-xl px-3 py-2.5 transition-colors"
                           style={{ background: isYou ? "rgba(73,234,203,0.04)" : "rgba(255,255,255,0.02)" }}>
                        <div className="flex items-center gap-3">
                          {/* Rank */}
                          <div className="w-6 shrink-0 text-center">
                            {isBondingCurve ? (
                              <span className="text-slate-700 text-xs">—</span>
                            ) : medal ? (
                              <span className="text-sm">{medal}</span>
                            ) : (
                              <span className="text-xs text-slate-600 font-bold">{rank}</span>
                            )}
                          </div>

                          {/* Avatar */}
                          {isBondingCurve ? (
                            <div className="w-7 h-7 rounded-lg flex items-center justify-center text-xs shrink-0"
                                 style={{ background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.25)" }}>
                              🔒
                            </div>
                          ) : (
                            <img
                              src={`https://api.dicebear.com/7.x/shapes/svg?seed=${h.address}`}
                              alt=""
                              className="w-7 h-7 rounded-lg shrink-0"
                            />
                          )}

                          {/* Address / label */}
                          <div className="flex-1 min-w-0">
                            {isBondingCurve ? (
                              <div>
                                <span className="text-xs font-medium text-slate-500">Curve inventory</span>
                                <span className="text-xs text-slate-700 ml-1.5">unsold token supply</span>
                              </div>
                            ) : (
                              <Link
                                to={`/profile/${h.address}`}
                                className={`flex items-center gap-1 text-xs font-mono hover:underline ${isYou ? "text-kas-400 font-semibold" : "text-slate-400 hover:text-white"}`}
                              >
                                {badges.get(h.address.toLowerCase())?.emoji && (
                                  <span title={badges.get(h.address.toLowerCase())!.label}>
                                    {badges.get(h.address.toLowerCase())!.emoji}
                                  </span>
                                )}
                                {fmt.address(h.address, 5)}{isYou ? " (you)" : ""}
                              </Link>
                            )}
                            {/* Bar */}
                            <div className="mt-1.5 h-1 rounded-full overflow-hidden bg-dark-800">
                              <div
                                className="h-full rounded-full transition-all duration-500"
                                style={{ width: `${Math.min(pct, 100)}%`, background: barColor }}
                              />
                            </div>
                          </div>

                          {/* Stats */}
                          <div className="text-right shrink-0">
                            <div className={`text-xs font-bold ${isBondingCurve ? "text-slate-600" : isYou ? "text-kas-400" : "text-slate-300"}`}>
                              {pct.toFixed(2)}%
                            </div>
                            <div className="text-xs text-slate-600">{fmt.token(h.balance)}</div>
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          )}

          {/* Description */}
          {meta?.description && (
            <div className="card">
              <h3 className="font-semibold text-white mb-2">About</h3>
              <p className="text-slate-400 text-sm leading-relaxed">{meta.description}</p>
            </div>
          )}

          {/* Comments */}
          <CommentSection tokenAddress={address!} />
        </div>

        {/* Right: buy/sell or graduated DEX panel */}
        <div className="space-y-4 order-first md:order-last">
          {isLegacy ? (
            <div className="rounded-2xl overflow-hidden"
                 style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(148,163,184,0.15)" }}>
              <div className="px-4 py-3 border-b"
                   style={{ borderColor: "rgba(148,163,184,0.1)", background: "rgba(148,163,184,0.04)" }}>
                <div className="text-xs font-bold uppercase tracking-widest mb-0.5 text-slate-500">Trading</div>
                <div className="text-sm font-semibold text-slate-400">Legacy token — read only</div>
              </div>
              <div className="p-4 space-y-3">
                <p className="text-sm text-slate-600 leading-relaxed">
                  Trading is disabled. This token was created on the original contract where graduation was structurally unreachable.
                </p>
                <Link
                  to="/legacy"
                  className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl text-sm font-semibold transition-all"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", color: "#94a3b8" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(73,234,203,0.3)"; e.currentTarget.style.color = "#49eacb"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "#94a3b8"; }}
                >
                  View all legacy tokens →
                </Link>
              </div>
            </div>
          ) : curve.complete ? (
            ACTIVE_CHAIN.testnet ? (
              <CurveCompletePanel />
            ) : (
              <GraduatedDexPanel
                tokenAddress={address!}
                tokenSymbol={meta?.symbol}
                tokenImage={meta?.image}
                dexPair={dexPair}
                kasLiquidity={dexKasLiquidity}
              />
            )
          ) : (
            <BuySellPanel
              tokenAddress={address!}
              curve={curve}
              onSuccess={() => setTimeout(() => load(true), 1500)}
              kasLaunchAddress={kasLaunchAddress}
              isLegacy={isLegacy}
            />
          )}

          {/* Token info */}
          <div className="card text-xs space-y-2">
            <div className="font-semibold text-slate-300 mb-1">Contract Info</div>
            <div className="flex justify-between items-center">
              <span className="text-slate-500">Address</span>
              <div className="flex items-center gap-1.5">
                <a href={`${EXPLORER_URL}/address/${address}`}
                   target="_blank" rel="noopener noreferrer"
                   className="font-mono text-kas-400 hover:text-kas-300">
                  {fmt.address(address!, 6)} ↗
                </a>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(address!);
                    setAddrCopied(true);
                    setTimeout(() => setAddrCopied(false), 2000);
                  }}
                  title="Copy contract address"
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "2px 4px",
                    color: addrCopied ? "#49eacb" : "#64748b",
                    transition: "color 0.2s",
                    fontSize: "13px",
                    lineHeight: 1,
                  }}
                >
                  {addrCopied ? "✓" : (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" strokeWidth="1.5"/>
                    </svg>
                  )}
                </button>
              </div>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Total Supply</span>
              <span className="text-slate-300 font-mono">1,000,000,000</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Holders</span>
              <span className="text-slate-300">{holderCount > 0 ? holderCount.toLocaleString() : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Status</span>
              <span className={curve.complete ? "text-kas-400" : gradPending ? "text-kas-400" : "text-blue-400"}>
                {curve.complete ? "🎓 Graduated" : gradPending ? "🎓 Graduation Pending" : "Bonding Curve"}
              </span>
            </div>
            {tokenBalance !== null && tokenBalance > 0n && (
              <>
                <div className="border-t border-white/5 pt-2 mt-1" />
                <div className="flex justify-between">
                  <span className="text-slate-500">Your Balance</span>
                  <span className="text-kas-400 font-semibold font-mono">
                    {fmt.token(tokenBalance)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Value</span>
                  <span className="text-slate-300 font-mono">
                    ≈ {fmt.kas(tokenBalance * price / 10n**18n, 4)} iKAS
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Share */}
          <div className="card space-y-3">
            <div className="font-semibold text-slate-300 text-xs">Share</div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(window.location.href);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="btn-secondary w-full text-sm"
            >
              {copied ? "Copied! ✓" : "Copy Link"}
            </button>
            <a
              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`Check out ${meta?.name || "this token"} ($${meta?.symbol}) on Zenith!`)}&url=${encodeURIComponent(window.location.href)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary w-full text-sm flex items-center justify-center gap-2"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.742l7.74-8.855L1.254 2.25H8.08l4.258 5.63 5.906-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Share on X
            </a>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
