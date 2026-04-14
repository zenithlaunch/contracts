import { useEffect, useState, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { useSettings } from "../contexts/SettingsContext";
import { ethers } from "ethers";
import { KAS_LAUNCH_ABI } from "../abis/kasLaunch";
import LaunchpadFactoryABI from "../abis/LaunchpadFactory.json";
import LaunchpadRaiseABI from "../abis/LaunchpadRaise.json";
import { CONTRACT_ADDRESSES, GRADUATION_KAS_THRESHOLD, KASLAUNCH_DEPLOY_BLOCK, LEGACY_BASELINE_TOKENS, LEGACY_BASELINE_VOLUME } from "../constants/contracts";
import { ACTIVE_CHAIN } from "../constants/chains";
import { filterHiddenTokens } from "../constants/hiddenTokens";
import { isBlockedTrader } from "../constants/hiddenTraders";
import { fmt } from "../utils/format";
import { fetchMetadata } from "../utils/ipfs";
import { getReadProvider } from "../utils/provider";
import { useCountUp } from "../hooks/useCountUp";
import { usePullToRefresh } from "../hooks/usePullToRefresh";
import { useKasPrice } from "../utils/kasPrice";
import { TokenCardSkeleton } from "../components/TokenCard";
import IpfsImage from "../components/IpfsImage";
import { registerTokenName } from "../components/LiveFeed";
import HomeRoadmap from "../components/HomeRoadmap";
import ScrollReveal, { ScrollRevealStagger } from "../components/ScrollReveal";

const TOKEN_META_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
] as const;

interface Stats {
  totalTokens: number;
  totalVolumeKas: bigint;
  totalRaisedKas: bigint;
}

interface RecentToken {
  address:  string;
  name:     string;
  symbol:   string;
  image?:   string;
  creator:  string;
  ts:       number;
  complete: boolean;
}

interface KingToken {
  address:   string;
  name:      string;
  symbol:    string;
  image?:    string;
  mcap:      bigint;
  realKas:   bigint;
  progress:  number;
  volume24h: bigint;
}

const HOME_CACHE_KEY = `${CONTRACT_ADDRESSES.KasLaunch ?? "no-kaslaunch"}:${KASLAUNCH_DEPLOY_BLOCK.toString()}`;

// Session-level cache — survives navigation, cleared on full reload
let cache: {
  stats?: Stats;
  rawV2VolumeKas?: bigint; // raw V2 trade volume without legacy baseline offset
  statsLastBlock?: number;
  recentTokens?: RecentToken[];
  king?: KingToken | null;
  trending?: KingToken[];
  ts: number;
  key?: string;
} = { ts: 0 };
const CACHE_TTL = 30_000; // 30s
const EVENT_SCAN_CHUNK = 5_000;

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen(!open)}
      className="w-full text-left rounded-2xl transition-colors duration-200"
      style={{
        background: open ? "rgba(73,234,203,0.06)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${open ? "rgba(73,234,203,0.2)" : "rgba(255,255,255,0.06)"}`,
      }}
    >
      <div className="flex items-center justify-between px-5 py-4">
        <span className="font-semibold text-white text-sm">{question}</span>
        <motion.span
          className="text-slate-500 text-lg shrink-0 ml-4"
          animate={{ rotate: open ? 45 : 0 }}
          transition={{ duration: 0.2 }}
        >
          +
        </motion.span>
      </div>
      <motion.div
        initial={false}
        animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
        transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
        className="overflow-hidden"
      >
        <p className="px-5 pb-4 text-sm text-slate-400 leading-relaxed">{answer}</p>
      </motion.div>
    </button>
  );
}

function StatsBar({ stats }: { stats: Stats }) {
  // fmt.kas converts bigint → number string like "12,345.67"
  // Parse to number so useCountUp can animate it
  const parseKas = (v: bigint) => Number(v / 10n ** 18n);

  const animTokens  = useCountUp(stats.totalTokens);
  const animVolume  = useCountUp(parseKas(stats.totalVolumeKas));
  const animRaised  = useCountUp(parseKas(stats.totalRaisedKas));

  return (
    <section className="max-w-5xl mx-auto px-4 mb-12">
      <ScrollRevealStagger className="grid grid-cols-1 sm:grid-cols-3 gap-3" stagger={0.15}>
        {[
          <div className="stat-box">
            <div className="stat-value">{animTokens.toLocaleString()}</div>
            <div className="stat-label">Tokens launched</div>
          </div>,
          <div className="stat-box">
            <div className="stat-value">{animVolume.toLocaleString()} iKAS</div>
            <div className="stat-label">Total volume</div>
          </div>,
          <div className="stat-box">
            <div className="stat-value">{animRaised.toLocaleString()} iKAS</div>
            <div className="stat-label">Total raised</div>
          </div>,
        ]}
      </ScrollRevealStagger>
    </section>
  );
}

export default function Home() {
  if (cache.key !== HOME_CACHE_KEY) {
    cache = { ts: 0, key: HOME_CACHE_KEY };
  }

  const [stats,        setStats]        = useState<Stats | null>(cache.stats ?? null);
  const [recentTokens, setRecentTokens] = useState<RecentToken[]>(cache.recentTokens ?? []);
  const [king,         setKing]         = useState<KingToken | null>(cache.king ?? null);
  const [trending,     setTrending]     = useState<KingToken[]>(cache.trending ?? []);
  const [loading,      setLoading]      = useState(!cache.ts);
  const kasPrice      = useKasPrice();
  const tokenCountRef = useRef(0);
  const videoRef      = useRef<HTMLVideoElement>(null);
  const { settings }  = useSettings();
  const rm            = settings.reducedMotion;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (rm) { v.pause(); } else { v.play().catch(() => {}); }
  }, [rm]);

  const refresh = useCallback(async () => {
    cache.ts = 0;
    await loadData();
  }, []);
  const { active: ptrActive, spinning: ptrSpinning } = usePullToRefresh(refresh);

  useEffect(() => {
    const stale = Date.now() - cache.ts > CACHE_TTL;
    if (stale) loadData();
    const id = setInterval(refreshStats, 30000);
    return () => clearInterval(id);
  }, []);

  function getProvider() {
    return getReadProvider();
  }

  async function loadTokenIdentity(
    provider: ethers.JsonRpcProvider,
    contract: ethers.Contract,
    addr: string,
  ) {
    const curve = await contract.getBondingCurve(addr);

    // Fetch ERC20 name/symbol (fast, on-chain) and IPFS metadata in parallel
    const [erc20Result, metaResult] = await Promise.allSettled([
      (async () => {
        const token = new ethers.Contract(addr, TOKEN_META_ABI, provider);
        const [n, s] = await Promise.all([token.name(), token.symbol()]);
        return { name: n as string, symbol: s as string };
      })(),
      fetchMetadata(curve.metadataUri),
    ]);

    const erc20 = erc20Result.status === "fulfilled" ? erc20Result.value : null;
    const meta  = metaResult.status  === "fulfilled" ? metaResult.value  : null;

    const name   = meta?.name   || erc20?.name   || "Unknown";
    const symbol = meta?.symbol || erc20?.symbol || "?";
    registerTokenName(addr, name, symbol);
    return { curve, name, symbol, image: meta?.image };
  }

  async function enrichRecentMetadata(contract: ethers.Contract, tokens: RecentToken[]) {
    const pending = tokens.filter((t) => t.name === "Unknown" || t.symbol === "?");
    if (pending.length === 0) return;

    const provider = getProvider();
    for (let i = 0; i < pending.length; i += 4) {
      await Promise.all(pending.slice(i, i + 4).map(async (token) => {
        try {
          const { name, symbol, image } = await loadTokenIdentity(provider, contract, token.address);
          setRecentTokens((prev) => {
            const next = prev.map((t) => t.address === token.address
              ? {
                  ...t,
                  name: name || t.name,
                  symbol: symbol || t.symbol,
                  image: image || t.image,
                }
              : t);
            cache.recentTokens = next;
            return next;
          });
        } catch {}
      }));
    }
  }

  async function queryFilterChunked(
    contract: ethers.Contract,
    filter: ethers.DeferredTopicFilter,
    fromBlock: number,
    toBlock: number,
  ) {
    const out: ethers.EventLog[] = [];
    for (let from = fromBlock; from <= toBlock; from += EVENT_SCAN_CHUNK) {
      const to = Math.min(from + EVENT_SCAN_CHUNK - 1, toBlock);
      const chunk = await contract.queryFilter(filter, from, to) as ethers.EventLog[];
      out.push(...chunk);
    }
    return out;
  }

  async function refreshStats() {
    if (!CONTRACT_ADDRESSES.KasLaunch) return;
    try {
      const provider = getProvider();
      const contract = new ethers.Contract(CONTRACT_ADDRESSES.KasLaunch, KAS_LAUNCH_ABI, provider);

      const [count, currentBlock] = await Promise.all([
        contract.getTokenCount() as Promise<bigint>,
        provider.getBlockNumber(),
      ]);
      const newCount = Number(count);

      // Accumulate raw V2 volume only — legacy baseline is added once at display time
      let rawV2Volume = cache.rawV2VolumeKas ?? 0n;
      const startBlock = cache.statsLastBlock != null
        ? cache.statsLastBlock + 1
        : Math.max(0, KASLAUNCH_DEPLOY_BLOCK);
      if (startBlock <= currentBlock) {
        const tradeEvents = await queryFilterChunked(contract, contract.filters.Trade(), startBlock, currentBlock);
        rawV2Volume += tradeEvents.reduce((sum, e) => {
          try {
            const trader = (e.args[4] as string).toLowerCase();
            if (isBlockedTrader(trader)) return sum;
            return sum + BigInt(e.args[1] ?? 0);
          } catch { return sum; }
        }, 0n);
      }
      cache.rawV2VolumeKas = rawV2Volume;
      cache.statsLastBlock = currentBlock;

      let totalRaised = 0n;
      if (CONTRACT_ADDRESSES.LaunchpadFactory) {
        try {
          const lpFactory = new ethers.Contract(CONTRACT_ADDRESSES.LaunchpadFactory, LaunchpadFactoryABI, provider);
          const raiseCount = Number(await lpFactory.getRaiseCount());
          if (raiseCount > 0) {
            const addrs: string[] = await lpFactory.getRaises(0, Math.min(raiseCount, 20));
            const amounts = await Promise.all(addrs.map(async (a) => {
              try {
                const raise = new ethers.Contract(a, LaunchpadRaiseABI, provider);
                return await raise.totalRaised() as bigint;
              } catch { return 0n; }
            }));
            totalRaised = amounts.reduce((s, v) => s + v, 0n);
          }
        } catch { /* non-fatal */ }
      }

      if (newCount !== tokenCountRef.current) {
        tokenCountRef.current = newCount;
        const offset = Math.max(0, newCount - 8);
        const addrs: string[] = await contract.getTokens(offset, newCount - offset);
        const tokens: RecentToken[] = await Promise.all(
          [...addrs].reverse().map(async (addr) => {
            try {
              const { curve, name, symbol, image } = await loadTokenIdentity(provider, contract, addr);
              return { address: addr, name, symbol, image, creator: curve.creator, ts: 0, complete: curve.complete };
            } catch {
              return { address: addr, name: "Unknown", symbol: "?", image: undefined, creator: "", ts: 0, complete: false };
            }
          })
        );
        const visibleTokens = filterHiddenTokens(tokens);
        cache.recentTokens = visibleTokens;
        setRecentTokens(visibleTokens);
        void enrichRecentMetadata(contract, visibleTokens);
      }

      const s = {
        totalTokens:    newCount + LEGACY_BASELINE_TOKENS,
        totalVolumeKas: rawV2Volume + LEGACY_BASELINE_VOLUME,
        totalRaisedKas: totalRaised,
      };
      cache.stats = s;
      setStats(s);
    } catch (err) {
      console.error("Failed to refresh stats:", err);
    }
  }

  async function loadData() {
    if (!CONTRACT_ADDRESSES.KasLaunch) return;
    try {
      const loadRecent = async () => {
        const provider = getProvider();
        const contract = new ethers.Contract(CONTRACT_ADDRESSES.KasLaunch, KAS_LAUNCH_ABI, provider);
        const count = Number(await contract.getTokenCount());
        if (count === 0) return;
        const offset = Math.max(0, count - 8);
        const addrs: string[] = await contract.getTokens(offset, count - offset);
        const tokens: RecentToken[] = await Promise.all(
          [...addrs].reverse().map(async (addr) => {
            try {
              const { curve, name, symbol, image } = await loadTokenIdentity(provider, contract, addr);
              return { address: addr, name, symbol, image, creator: curve.creator, ts: 0, complete: curve.complete };
            } catch {
              return { address: addr, name: "Unknown", symbol: "?", image: undefined, creator: "", ts: 0, complete: false };
            }
          })
        );
        const visibleTokens = filterHiddenTokens(tokens);
        cache.recentTokens = visibleTokens;
        setRecentTokens(visibleTokens);
        void enrichRecentMetadata(contract, visibleTokens);
      };

      await Promise.all([loadRecent(), loadKing()]);
      cache.ts = Date.now();
      void refreshStats();
    } catch (err) {
      console.error("Failed to load home data:", err);
    } finally {
      setLoading(false);
    }
  }

  async function loadKing() {
    if (!CONTRACT_ADDRESSES.KasLaunch) return;
    try {
      const provider = getProvider();
      const contract = new ethers.Contract(CONTRACT_ADDRESSES.KasLaunch, KAS_LAUNCH_ABI, provider);

      const count = Number(await contract.getTokenCount());
      if (count === 0) return;
      const addrs: string[] = await contract.getTokens(0, Math.min(count, 50));

      // Phase 1: collect all active tokens with mcap
      const candidates: { addr: string; curve: any; mcap: bigint }[] = [];

      await Promise.all(addrs.map(async (addr) => {
        try {
          const [curve, mcap] = await Promise.all([
            contract.getBondingCurve(addr),
            contract.getMarketCap(addr),
          ]);
          if (curve.complete) return;
          candidates.push({ addr, curve, mcap });
        } catch {}
      }));

      if (candidates.length === 0) return;

      // Sort by mcap descending
      candidates.sort((a, b) => (b.mcap > a.mcap ? 1 : b.mcap < a.mcap ? -1 : 0));

      const best = candidates[0];
      const progress = Math.min(100, Number((best.curve.realKasReserves * 100n) / GRADUATION_KAS_THRESHOLD));

      // Phase 2: metadata for king
      const erc20Contract = new ethers.Contract(best.addr, TOKEN_META_ABI, provider);
      const [ipfsResult, erc20Result, tradeEvents] = await Promise.all([
        fetchMetadata(best.curve.metadataUri).catch(() => null),
        Promise.all([erc20Contract.name().catch(() => ""), erc20Contract.symbol().catch(() => "")]),
        contract.queryFilter(contract.filters.Trade(best.addr), -86400).catch(() => []) as Promise<ethers.EventLog[]>,
      ]);

      const volume24h = (tradeEvents as ethers.EventLog[]).reduce((s, e) => {
        try { return s + BigInt(e.args[1] ?? 0); } catch { return s; }
      }, 0n);

      const k = {
        address:   best.addr,
        name:      ipfsResult?.name   || (erc20Result[0] as string) || "Unknown",
        symbol:    ipfsResult?.symbol || (erc20Result[1] as string) || "?",
        image:     ipfsResult?.image,
        mcap:      best.mcap,
        realKas:   best.curve.realKasReserves,
        progress,
        volume24h,
      };
      cache.king = k;
      setKing(k);

      // Phase 3: enrich trending (top 2-7 by mcap, skip king)
      const trendingCandidates = candidates.slice(1, 7);
      const trendingTokens = await Promise.all(trendingCandidates.map(async (c) => {
        try {
          const prog = Math.min(100, Number((c.curve.realKasReserves * 100n) / GRADUATION_KAS_THRESHOLD));
          const { name, symbol, image } = await loadTokenIdentity(provider, contract, c.addr);
          return {
            address: c.addr,
            name,
            symbol,
            image,
            mcap: c.mcap,
            realKas: c.curve.realKasReserves,
            progress: prog,
            volume24h: 0n,
          } as KingToken;
        } catch {
          return null;
        }
      }));
      const filtered = trendingTokens.filter((t): t is KingToken => t !== null && t.name !== "Unknown");
      cache.trending = filtered;
      setTrending(filtered);
    } catch {}
  }

  return (
    <div>
      {/* Pull-to-refresh indicator */}
      <div className={`ptr-indicator ${(ptrActive || ptrSpinning) ? "ptr-visible" : ""}`}>
        <div className="ptr-spinner" />
      </div>
      {/* Hero — full screen video style, pulls back above main's pt-16 */}
      <section className="relative overflow-hidden" style={{ height: "100svh", marginTop: "-64px", marginBottom: "0" }}>
        {/* Video */}
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          src="/159063-818020287.mp4"
          autoPlay={!rm} loop muted playsInline
          style={{ filter: "hue-rotate(165deg) saturate(2.0) brightness(0.85)" }}
        />
        {/* Blur */}
        <div className="absolute inset-0" style={{ backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }} />
        {/* Dark overlay */}
        <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, rgba(4,8,15,0.6) 0%, rgba(4,8,15,0.35) 50%, rgba(4,8,15,0.0) 85%)" }} />
        {/* Smooth fade into page at bottom */}
        <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{ height: "220px", background: "linear-gradient(to bottom, transparent 0%, #04080f 100%)" }} />
        {/* Teal glow */}
        <div className="absolute -top-8 left-1/2 -translate-x-1/2 w-[900px] h-[500px] pointer-events-none"
             style={{ background: "radial-gradient(ellipse, rgba(73,234,203,0.12) 0%, transparent 60%)" }} />

        {/* Content */}
        <div className="relative z-10 flex flex-col h-full">

          {/* Two-column descriptor row */}
          <div className="flex-shrink-0 pt-20 px-4">
            <div className="max-w-5xl mx-auto">
              <motion.div
                className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2"
                initial={rm ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.05 }}
              >
                <p className="text-white/50 text-xs sm:text-sm leading-relaxed max-w-sm">
                  Fair-launch memecoins with bonding curves. Serious raises with on-chain vesting.
                </p>
                <p className="text-white/50 text-xs sm:text-sm sm:text-right">
                  Testnet Live · Igra Network · April 8, 2026
                </p>
              </motion.div>
            </div>
          </div>

          {/* Center hero content */}
          <div className="flex-1 flex flex-col items-center justify-center text-center px-4">

            {/* Badge */}
            <motion.div
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-semibold mb-6"
              style={{ background: "rgba(73,234,203,0.07)", border: "1px solid rgba(73,234,203,0.18)", color: "#49eacb" }}
              initial={rm ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-kas-400 animate-pulse" />
              Testnet Live — Igra Network
            </motion.div>

            {/* Heading */}
            <motion.h1
              className="font-display font-bold text-white mb-10"
              style={{ fontSize: "clamp(3.2rem, 9vw, 6.5rem)", lineHeight: 0.88, letterSpacing: "-0.04em" }}
              initial={rm ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.15 }}
            >
              <div>Launch tokens.</div>
              <div>
                <motion.span
                  style={{
                    backgroundImage: "linear-gradient(100deg, #49eacb 0%, #49eacb 20%, #ffffff 50%, #49eacb 80%, #49eacb 100%)",
                    backgroundSize: "200% 100%",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    backgroundClip: "text",
                    display: "inline-block",
                  }}
                  animate={rm ? {} : { backgroundPosition: ["0% 0%", "100% 0%"] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                >
                  On Kaspa.
                </motion.span>
              </div>
            </motion.h1>

            {/* CTAs */}
            <motion.div
              className="flex flex-col sm:flex-row gap-3 mb-6"
              initial={rm ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.25 }}
            >
              <Link to="/launch">
                <motion.span
                  className="inline-flex items-center gap-2 text-sm font-bold rounded-full px-9 py-4 cursor-pointer"
                  style={{
                    background: "linear-gradient(135deg, #49eacb 0%, #14b8a6 60%, #0d9488 100%)",
                    color: "#030a0a",
                    boxShadow: "0 0 0 1px rgba(73,234,203,0.35), 0 4px 24px rgba(73,234,203,0.28)",
                  }}
                  whileHover={{ scale: 1.03, boxShadow: "0 0 0 1px rgba(73,234,203,0.5), 0 0 32px rgba(73,234,203,0.4)" }}
                  whileTap={{ scale: 0.97 }}
                >
                  ⚡ Launch a Token
                </motion.span>
              </Link>
              <Link to="/explore">
                <motion.span
                  className="inline-flex items-center gap-2 text-sm font-medium rounded-full px-9 py-4 cursor-pointer text-white/80 hover:text-white"
                  style={{
                    background: "rgba(255,255,255,0.06)",
                    border: "1px solid rgba(255,255,255,0.14)",
                    backdropFilter: "blur(8px)",
                  }}
                  whileHover={{ scale: 1.02, background: "rgba(255,255,255,0.1)" }}
                  whileTap={{ scale: 0.97 }}
                >
                  Explore Tokens →
                </motion.span>
              </Link>
            </motion.div>

            {/* Rewards banner */}
            <motion.div
              initial={rm ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.35 }}
            >
              <Link to="/testnet-rewards"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold transition-all hover:scale-105"
                    style={{ background: "rgba(251,191,36,0.07)", border: "1px solid rgba(251,191,36,0.2)", color: "#fbbf24" }}>
                🎁 100,000 KAS reward pool for Testnet Pioneers — learn more →
              </Link>
            </motion.div>
          </div>

        </div>
      </section>

      {/* Stats bar */}
      {stats && <StatsBar stats={stats} />}

      {/* King of the Hill */}
      {loading && !king && (
        <section className="max-w-5xl mx-auto px-4 mb-10">
          <div className="rounded-3xl animate-pulse" style={{ height: 200, background: "rgba(73,234,203,0.04)", border: "1px solid rgba(73,234,203,0.1)" }} />
        </section>
      )}
      {king && (
        <ScrollReveal delay={0.1}>
        <section className="max-w-5xl mx-auto px-4 mb-10">
          <Link to={`/token/${king.address}`} className="block group">
            <div className="relative overflow-hidden rounded-3xl cursor-pointer transition-all duration-300"
                 style={{
                   background: "linear-gradient(135deg, rgba(73,234,203,0.08) 0%, rgba(20,184,166,0.03) 60%, rgba(0,0,0,0) 100%)",
                   border: "1px solid rgba(73,234,203,0.25)",
                   boxShadow: "0 0 40px rgba(73,234,203,0.08), inset 0 1px 0 rgba(73,234,203,0.1)",
                 }}>

              {/* Background glow blobs */}
              <div className="absolute -top-20 -right-20 w-64 h-64 rounded-full pointer-events-none"
                   style={{ background: "radial-gradient(circle, rgba(73,234,203,0.07) 0%, transparent 70%)" }} />
              <div className="absolute -bottom-16 -left-16 w-48 h-48 rounded-full pointer-events-none"
                   style={{ background: "radial-gradient(circle, rgba(20,184,166,0.05) 0%, transparent 70%)" }} />

              <div className="relative p-6 sm:p-8">
                {/* Header row */}
                <div className="flex items-start justify-between mb-5">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">👑</span>
                    <div>
                      <div className="text-xs font-bold uppercase tracking-widest"
                           style={{ color: "#49eacb" }}>King of the Hill</div>
                      <div className="text-xs text-slate-600">highest market cap · bonding curve</div>
                    </div>
                  </div>
                  {king.volume24h > 0n && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold"
                         style={{ background: "rgba(73,234,203,0.1)", border: "1px solid rgba(73,234,203,0.2)", color: "#49eacb" }}>
                      🔥 {fmt.kas(king.volume24h)} iKAS 24h vol
                    </div>
                  )}
                </div>

                {/* Main content */}
                <div className="flex flex-col sm:flex-row items-center sm:items-start gap-5">
                  {/* Image */}
                  <div className="relative shrink-0">
                    <IpfsImage
                      hash={king.image || ""}
                      fallbackSrc={`https://api.dicebear.com/7.x/shapes/svg?seed=${king.address}`}
                      className="w-24 h-24 rounded-2xl object-cover bg-dark-800 group-hover:scale-105 transition-transform duration-300"
                      alt={king.name}
                      loading="eager"
                      style={{ boxShadow: "0 0 20px rgba(73,234,203,0.2)" }}
                    />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0 text-center sm:text-left">
                    <div className="flex items-center justify-center sm:justify-start gap-2 mb-1">
                      <span className="text-2xl font-extrabold text-white tracking-tight">{king.name}</span>
                      <span className="text-slate-500 font-mono text-sm">${king.symbol}</span>
                    </div>

                    {/* Stats row */}
                    <div className="flex items-center justify-center sm:justify-start gap-4 mb-4 text-sm">
                      <div>
                        <span className="text-slate-600 text-xs">Raised </span>
                        <span className="text-white font-semibold">{fmt.kas(king.realKas)} iKAS</span>
                      </div>
                      <div className="w-px h-3 bg-slate-800" />
                      <div>
                        <span className="text-slate-600 text-xs">MCap </span>
                        <span className="text-white font-semibold">
                          {kasPrice ? fmt.usd(king.mcap, kasPrice) : `${fmt.kas(king.mcap)} iKAS`}
                        </span>
                      </div>
                      {king.progress < 100 && (
                        <>
                          <div className="w-px h-3 bg-slate-800" />
                          <div>
                            <span className="text-slate-600 text-xs">{ACTIVE_CHAIN.testnet ? "To Grad " : "To DEX "}</span>
                            <span className="text-kas-400 font-semibold">
                              {fmt.kas(GRADUATION_KAS_THRESHOLD - king.realKas)} iKAS
                            </span>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Progress bar */}
                    {king.progress < 100 ? (
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-3 rounded-full bg-dark-800 overflow-hidden"
                             style={{ boxShadow: "inset 0 1px 3px rgba(0,0,0,0.4)" }}>
                          <div className="h-full rounded-full transition-all duration-700 relative overflow-hidden"
                               style={{
                                 width: `${king.progress}%`,
                                 background: king.progress >= 80
                                   ? "linear-gradient(90deg, #49eacb, #14b8a6, #49eacb)"
                                   : "linear-gradient(90deg, #49eacb, #14b8a6)",
                                 boxShadow: "0 0 12px rgba(73,234,203,0.6)",
                                 backgroundSize: king.progress >= 80 ? "200% 100%" : "100% 100%",
                                 animation: king.progress >= 80 ? "shimmer 2s linear infinite" : "none",
                               }} />
                        </div>
                        <span className="text-kas-400 font-black text-base shrink-0 tabular-nums">
                          {king.progress}%
                        </span>
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold"
                           style={{ background: "rgba(73,234,203,0.12)", border: "1px solid rgba(73,234,203,0.35)", color: "#49eacb" }}>
                        🎓 Curve complete — graduation pending
                      </div>
                    )}
                    {king.progress < 100 && (
                      <div className="text-xs text-slate-600 mt-1.5 text-center sm:text-left">
                        {ACTIVE_CHAIN.testnet ? "to graduation 🎓" : "to graduation on DEX 🎓"}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </Link>
        </section>
        </ScrollReveal>
      )}

      {/* Trending carousel */}
      {trending.length > 0 && (
        <ScrollReveal delay={0.1}>
        <section className="max-w-7xl mx-auto px-4 mb-10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-kas-400 animate-pulse" />
              Trending
            </h2>
            <Link to="/explore" className="text-sm text-kas-400 hover:text-kas-300">
              View all →
            </Link>
          </div>
          <div className="flex gap-4 overflow-x-auto pb-3 scrollbar-hide snap-x snap-mandatory -mx-4 px-4">
            {trending.map((t) => (
              <Link
                key={t.address}
                to={`/token/${t.address}`}
                className="snap-start shrink-0 w-[260px] group"
              >
                <div
                  className="rounded-2xl p-4 transition-all duration-200 h-full"
                  style={{
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(73,234,203,0.06)";
                    e.currentTarget.style.borderColor = "rgba(73,234,203,0.2)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(255,255,255,0.03)";
                    e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)";
                  }}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <IpfsImage
                      hash={t.image || ""}
                      fallbackSrc={`https://api.dicebear.com/7.x/shapes/svg?seed=${t.address}&size=40`}
                      width={40}
                      height={40}
                      loading="lazy"
                      className="w-10 h-10 rounded-xl object-cover bg-dark-800 shrink-0 group-hover:scale-105 transition-transform"
                      alt={t.name}
                    />
                    <div className="min-w-0">
                      <div className="font-semibold text-white text-sm truncate">{t.name}</div>
                      <div className="text-xs text-slate-500">${t.symbol}</div>
                    </div>
                  </div>
                  <div className="flex justify-between text-xs mb-2">
                    <span className="text-slate-500">MCap</span>
                    <span className="text-white font-medium">
                      {kasPrice ? fmt.usd(t.mcap, kasPrice) : `${fmt.kas(t.mcap)} iKAS`}
                    </span>
                  </div>
                  <div className="progress-bar mb-1">
                    <div
                      className={`progress-fill${t.progress >= 80 ? " progress-fill-hot" : ""}`}
                      style={{ width: `${t.progress}%` }}
                    />
                  </div>
                  <div className="text-xs text-slate-600 text-right">{t.progress}%</div>
                </div>
              </Link>
            ))}
          </div>
        </section>
        </ScrollReveal>
      )}

      {/* Newest tokens — full width */}
      <ScrollReveal delay={0.15}>
      <section className="max-w-7xl mx-auto px-4 pb-16">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white">Newest Tokens</h2>
          <Link to="/explore" className="text-sm text-kas-400 hover:text-kas-300">
            View all →
          </Link>
        </div>

        {loading && recentTokens.length === 0 ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <TokenCardSkeleton key={i} />
            ))}
          </div>
        ) : recentTokens.length === 0 ? (
          <div className="card text-center py-12 text-slate-600">
            <div className="text-4xl mb-3">🚀</div>
            <p>No tokens yet. Be the first to launch!</p>
            <Link to="/launch" className="btn-primary mt-4 inline-block">
              Launch Token
            </Link>
          </div>
        ) : (
          <ScrollRevealStagger className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4" stagger={0.12} distance={40}>
            {recentTokens.map((t) => (
              <Link key={t.address} to={`/token/${t.address}`} className="block">
                <div className="card-hover flex items-center gap-3">
                  <IpfsImage
                    hash={t.image || ""}
                    fallbackSrc={`https://api.dicebear.com/7.x/shapes/svg?seed=${t.address}&size=48`}
                    width={48}
                    height={48}
                    loading="lazy"
                    className="w-12 h-12 rounded-xl object-cover bg-dark-800 shrink-0"
                    alt={t.name}
                  />
                  <div className="min-w-0">
                    <div className="font-semibold text-white truncate">{t.name}</div>
                    <div className="text-xs text-slate-500">
                      ${t.symbol} · {fmt.address(t.creator, 4)}
                    </div>
                  </div>
                  <div className="ml-auto shrink-0">
                    {t.complete
                      ? <span className="text-xs px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "rgba(73,234,203,0.1)", color: "#49eacb", border: "1px solid rgba(73,234,203,0.2)" }}>{ACTIVE_CHAIN.testnet ? "Curve Complete" : "Graduated"}</span>
                      : <span className="badge-gray text-xs">New</span>
                    }
                  </div>
                </div>
              </Link>
            ))}
          </ScrollRevealStagger>
        )}
      </section>
      </ScrollReveal>

      {/* Roadmap */}
      <ScrollReveal delay={0.1}>
        <HomeRoadmap />
      </ScrollReveal>

      {/* How it works */}
      <ScrollReveal delay={0.1}>
      <section id="how-it-works" className="border-t border-slate-800 py-16 px-4">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-white text-center mb-10">How it works</h2>

          <ScrollRevealStagger className="grid md:grid-cols-2 gap-8" stagger={0.2} distance={50}>
            {[
            <div className="card">
              <div className="text-2xl mb-3">⚡ Quick Launch (Memecoin)</div>
              <div className="space-y-3 text-sm text-slate-400">
                {[
                  ["1", "Pay 150 iKAS deploy fee → token created instantly"],
                  ["2", "1 billion tokens locked in bonding curve"],
                  ["3", "Buy/sell anytime on the xy=k curve (1% fee)"],
                  ["4", "When the curve reaches 300K iKAS → auto-graduates to DEX 🎓"],
                ].map(([n, text]) => (
                  <div key={n} className="flex gap-3">
                    <span className="w-6 h-6 rounded-full bg-kas-900 text-kas-400 text-xs
                                     flex items-center justify-center shrink-0 font-bold">
                      {n}
                    </span>
                    <span>{text}</span>
                  </div>
                ))}
              </div>
            </div>,
            <div className="card">
              <div className="text-2xl mb-3">🚀 Serious Launch (Launchpad)</div>
              <div className="space-y-3 text-sm text-slate-400">
                {[
                  ["1", "Apply with project info, hardcap, softcap, token price"],
                  ["2", "Zenith team reviews and approves your raise"],
                  ["3", "Investors commit KAS during the raise window"],
                  ["4", "If softcap met → tokens distributed, KAS to team"],
                  ["5", "Vesting schedule enforced on-chain automatically"],
                ].map(([n, text]) => (
                  <div key={n} className="flex gap-3">
                    <span className="w-6 h-6 rounded-full bg-blue-900 text-blue-400 text-xs
                                     flex items-center justify-center shrink-0 font-bold">
                      {n}
                    </span>
                    <span>{text}</span>
                  </div>
                ))}
              </div>
            </div>,
            ]}
          </ScrollRevealStagger>
        </div>
      </section>
      </ScrollReveal>

      {/* FAQ */}
      <ScrollReveal delay={0.1}>
      <section className="border-t border-slate-800 py-16 px-4">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold text-white text-center mb-10">Frequently Asked Questions</h2>
          <ScrollRevealStagger className="space-y-3" stagger={0.1} distance={30}>
            {[
              {
                q: "What is Zenith?",
                a: "Zenith is a fair-launch token platform on Kaspa L2 (Igra Network). Anyone can create a token with a bonding curve — no pre-sales, no admin keys, no rug pulls.",
              },
              {
                q: "How does the bonding curve work?",
                a: "Each token uses an xy=k curve. The price rises as more people buy and falls when they sell. Once the curve reaches 300K iKAS in reserves, it auto-graduates to the DEX with locked liquidity.",
              },
              {
                q: "What does graduation mean?",
                a: "When a token's bonding curve fills up (300K iKAS), it automatically lists on ZealousSwap DEX. Liquidity is locked permanently — no one can pull it.",
              },
              {
                q: "What are the fees?",
                a: "150 iKAS to create a token. 1% fee on every buy/sell trade. 2% graduation fee when the token moves to DEX. No hidden fees.",
              },
              {
                q: "Is this on mainnet?",
                a: "Contracts are deployed on Igra mainnet. The frontend is currently live on testnet — mainnet frontend launch is coming soon.",
              },
              {
                q: "How do I get iKAS?",
                a: "Bridge your KAS to the Igra Network using KatBridge. On testnet, you can use the faucet to get free test iKAS.",
              },
            ].map((item) => (
              <FaqItem key={item.q} question={item.q} answer={item.a} />
            ))}
          </ScrollRevealStagger>
        </div>
      </section>
      </ScrollReveal>
    </div>
  );
}
