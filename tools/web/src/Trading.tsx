import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  clock,
  describe,
  get,
  money,
  send,
  usePoll,
  type Instrument,
  type Order,
  type Portfolio,
} from './api';
import { Tag, type Tone } from './ui';

const USERS = [1, 2, 3, 4];
const SEARCH_DEBOUNCE_MS = 300;
const AMOUNT = /^\d+(\.\d{1,2})?$/;

const STATUS_TONE: Record<string, Tone> = {
  FILLED: 'pos',
  REJECTED: 'neg',
  NEW: 'info',
  CANCELLED: 'mute',
};

const returnTone = (percent: string): Tone =>
  percent.startsWith('-') ? 'neg' : /^-?0(\.0+)?$/.test(percent) ? 'mute' : 'pos';

// A market order is rejected on exactly one condition — the placement was not covered — so
// naming the side's own shortfall states the rule rather than guessing at a cause.
const rejection = (order: Order): string =>
  order.side === 'BUY'
    ? `Not enough available cash for ${order.size} at ${money(order.price)} each.`
    : `Not enough shares held to sell ${order.size}.`;

type Placed = { key: number; at: string; ticker: string; order?: Order; errors?: string[] };

export default function Trading() {
  const [userId, setUserId] = useState(1);
  const portfolio = usePoll<Portfolio>(`/api/users/${userId}/portfolio`);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Instrument[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Instrument | null>(null);

  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [sizing, setSizing] = useState<'size' | 'amount'>('size');
  const [size, setSize] = useState('1');
  const [amount, setAmount] = useState('50000.00');
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<Placed[]>([]);

  useEffect(() => {
    const term = query.trim();
    if (term === '') {
      setHits([]);
      setSearchError(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      get<Instrument[]>(`/api/instruments?q=${encodeURIComponent(term)}`)
        .then((found) => {
          if (live) {
            setHits(found);
            setSearchError(null);
          }
        })
        .catch((error: unknown) => {
          if (live) {
            setHits([]);
            setSearchError(describe(error));
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const sizeOk = /^[1-9]\d*$/.test(size);
  const amountOk = AMOUNT.test(amount);
  const ready = picked !== null && !placing && (sizing === 'size' ? sizeOk : amountOk);

  const place = async (): Promise<void> => {
    if (picked === null) {
      return;
    }
    setPlacing(true);
    const key = Date.now();
    const at = new Date().toISOString();
    try {
      // `amount` is exact 2-decimal text in the field and stays text until the wire: the
      // challenge API validates it as a JSON number, so the string is converted here and
      // nowhere else — every other money value in this app is rendered as it arrived.
      const order = await send<Order>('POST', '/api/orders', {
        userId,
        instrumentId: picked.id,
        side,
        type: 'MARKET',
        ...(sizing === 'size' ? { size: Number(size) } : { amount: Number(amount) }),
      });
      setPlaced((rows) => [{ key, at, ticker: picked.ticker, order }, ...rows].slice(0, 8));
    } catch (error) {
      const errors = error instanceof ApiError ? error.messages : [describe(error)];
      setPlaced((rows) => [{ key, at, ticker: picked.ticker, errors }, ...rows].slice(0, 8));
    } finally {
      setPlacing(false);
      portfolio.reload();
    }
  };

  const held = portfolio.data?.positions ?? [];

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span>
            <b>Mesa</b>
            <em>Trading desk</em>
          </span>
        </div>
        <div className="users" role="group" aria-label="Account">
          {USERS.map((id) => (
            <button
              key={id}
              type="button"
              className={`pill${id === userId ? ' on' : ''}`}
              aria-pressed={id === userId}
              onClick={() => setUserId(id)}
            >
              User {id}
            </button>
          ))}
        </div>
        <Link className="quiet-link" to="/backoffice">
          Back office
        </Link>
      </header>

      <main className="grid">
        <section className="col-main">
          <div className="hero">
            <span className="eyebrow">Portfolio value · user {userId}</span>
            <strong className="hero-value">
              {portfolio.data === undefined ? '—' : `$ ${money(portfolio.data.totalValue)}`}
            </strong>
            <div className="hero-foot">
              <span className="hero-chip">
                Available cash
                <b>
                  {portfolio.data === undefined
                    ? '—'
                    : `$ ${money(portfolio.data.availableCash)}`}
                </b>
              </span>
              <span className="hero-note">
                {held.length} {held.length === 1 ? 'position' : 'positions'} · refreshed every 2s
              </span>
            </div>
            {portfolio.error !== null && (
              <p className="hero-error">Last refresh failed: {portfolio.error}</p>
            )}
          </div>

          <div className="card">
            <h2>Find an instrument</h2>
            <input
              className="search"
              type="search"
              value={query}
              placeholder="Ticker or company name"
              aria-label="Search instruments"
              onChange={(event) => setQuery(event.target.value)}
            />
            {searchError !== null && <p className="inline-error">{searchError}</p>}
            <ul className="hits">
              {hits.map((instrument) => (
                <li key={instrument.id}>
                  <button
                    type="button"
                    className={`hit${picked?.id === instrument.id ? ' on' : ''}`}
                    onClick={() => setPicked(instrument)}
                  >
                    <span>
                      <b className="ticker">{instrument.ticker}</b>
                      <span className="sub">{instrument.name}</span>
                    </span>
                    <Tag tone="info">{instrument.type}</Tag>
                  </button>
                </li>
              ))}
              {query.trim() !== '' && hits.length === 0 && searchError === null && (
                <li className="empty">Nothing matches “{query.trim()}”.</li>
              )}
            </ul>
          </div>

          <div className="card">
            <h2>Positions</h2>
            {held.length === 0 ? (
              <p className="empty">
                No shares yet. Search for an instrument and place your first order.
              </p>
            ) : (
              <table className="rows">
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th className="right">Shares</th>
                    <th className="right">Avg cost</th>
                    <th className="right">Market value</th>
                    <th className="right">Return</th>
                  </tr>
                </thead>
                <tbody>
                  {held.map((position) => (
                    <tr key={position.instrumentId}>
                      <td>
                        <b className="ticker">{position.ticker}</b>
                        <span className="sub">{position.name}</span>
                      </td>
                      <td className="right num">{position.quantity}</td>
                      {/* Net short: no average cost, and no return to tone either way. The
                          dash is the honest reading of a figure the API declined to state. */}
                      <td className="right num">
                        {position.avgCost === null ? '—' : money(position.avgCost)}
                      </td>
                      <td className="right num strong">{money(position.marketValue)}</td>
                      <td className="right">
                        {position.totalReturnPct === null ? (
                          <Tag>—</Tag>
                        ) : (
                          <Tag tone={returnTone(position.totalReturnPct)}>
                            {position.totalReturnPct}%
                          </Tag>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

        </section>

        <section className="col-side">
          <div className="card ticket">
            <h2>New order</h2>
            <div className="segmented sides">
              <button
                type="button"
                className={`seg buy${side === 'BUY' ? ' on' : ''}`}
                aria-pressed={side === 'BUY'}
                onClick={() => setSide('BUY')}
              >
                Buy
              </button>
              <button
                type="button"
                className={`seg sell${side === 'SELL' ? ' on' : ''}`}
                aria-pressed={side === 'SELL'}
                onClick={() => setSide('SELL')}
              >
                Sell
              </button>
            </div>

            <div className="picked">
              {picked === null ? (
                <span className="empty">Pick an instrument to trade.</span>
              ) : (
                <>
                  <b className="ticker">{picked.ticker}</b>
                  <span className="sub">{picked.name}</span>
                </>
              )}
              <Tag tone="mute">MARKET</Tag>
            </div>

            <div className="segmented">
              <button
                type="button"
                className={`seg${sizing === 'size' ? ' on' : ''}`}
                aria-pressed={sizing === 'size'}
                onClick={() => setSizing('size')}
              >
                By shares
              </button>
              <button
                type="button"
                className={`seg${sizing === 'amount' ? ' on' : ''}`}
                aria-pressed={sizing === 'amount'}
                onClick={() => setSizing('amount')}
              >
                By amount
              </button>
            </div>

            {sizing === 'size' ? (
              <label className="field">
                <span>Shares</span>
                <input
                  inputMode="numeric"
                  value={size}
                  onChange={(event) => setSize(event.target.value)}
                />
                {!sizeOk && <em className="hint">Whole shares, 1 or more.</em>}
              </label>
            ) : (
              <label className="field">
                <span>Amount in ARS</span>
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
                {!amountOk && <em className="hint">Pesos and centavos, e.g. 50000.00.</em>}
              </label>
            )}

            <button
              type="button"
              className={`cta ${side === 'BUY' ? 'cta-buy' : 'cta-sell'}`}
              disabled={!ready}
              onClick={() => void place()}
            >
              {placing ? 'Sending…' : side === 'BUY' ? 'Place buy order' : 'Place sell order'}
            </button>
          </div>

          <div className="card">
            <h2>This session</h2>
            {placed.length === 0 ? (
              <p className="empty">Orders you place here show up in this list.</p>
            ) : (
              <ul className="feed">
                {placed.map((row) => (
                  <li key={row.key}>
                    <div className="feed-head">
                      <b className="ticker">{row.ticker}</b>
                      {row.order === undefined ? (
                        <Tag tone="warn">NOT PLACED</Tag>
                      ) : (
                        <Tag tone={STATUS_TONE[row.order.status] ?? 'mute'}>
                          {row.order.status}
                        </Tag>
                      )}
                      <span className="feed-time num">{clock(row.at)}</span>
                    </div>
                    {row.order !== undefined && (
                      <p className="feed-body">
                        <span className={row.order.side === 'BUY' ? 't-pos' : 't-neg'}>
                          {row.order.side}
                        </span>{' '}
                        <span className="num">{row.order.size}</span> at{' '}
                        <span className="num">{money(row.order.price)}</span> · order #
                        <span className="num">{row.order.id}</span>
                      </p>
                    )}
                    {row.order?.status === 'REJECTED' && (
                      <p className="feed-reason">{rejection(row.order)}</p>
                    )}
                    {row.errors?.map((message) => (
                      <p key={message} className="feed-reason">
                        {message}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
