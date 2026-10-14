/*
 * Pool Lens Academy — the course content and its router.
 *
 * Structured the way Pendle Academy is: a persistent sidebar of chapters grouped into sections,
 * a course level on each chapter, and Previous/Next at the foot so it reads as a sequence rather
 * than a pile of pages. Chapters live here as data and render into one shell, so adding one is a
 * single entry rather than another HTML file to keep in step.
 *
 * Every number quoted in the prose is one this project measured. They are collected in
 * NUMBERS below so a figure cannot drift between chapters, and so the places that would need
 * updating if the data changed are in one list rather than scattered through paragraphs.
 */
window.LP = window.LP || {};

LP.academy = (function () {
  const esc = (s) => LP.util.escapeHtml(s);

  /*
   * Measured figures, defined once. Each is cited in the chapter that uses it.
   */
  const NUMBERS = {
    vrBenchmark: '0.25',
    il2x: '−5.72%',
    il4x: '−20%',
    campaignMedianDays: '21 days',
    campaignUnder30: '73%',
    campaignOver180: '2 of 366',
    tauOverstate: '45%',
    smallPosition: '−0.83%',
    bigPosition: '+22.86%',
    pendleGap: '0.01 percentage points',
    backtestConfigs: '27',
    calmPairsWins: '14 of 27',
    noIlWorst: '+2.94%',
    dualBenchWorst: '−1.50%',
    washTrades: '12',
    normalTrades: '1.5 to 2.5',
    honeypotSells: '0.1'
  };

  const n = (k) => '<span class="num-chip">' + NUMBERS[k] + '</span>';

  /* ------------------------------------------------------------------ content */

  const SECTIONS = [
    {
      title: 'Pool Lens 101',
      icon: '1',
      chapters: ['start', 'ch1', 'ch2', 'ch3', 'takeaways-101']
    },
    {
      title: 'Using the tool',
      icon: '2',
      chapters: ['ch4', 'ch5', 'ch6', 'ch7']
    },
    {
      title: 'Going deeper',
      icon: '3',
      chapters: ['ch8', 'ch9', 'ch10', 'takeaways-advanced', 'cheatsheet']
    }
  ];

  const CHAPTERS = {

    /* ------------------------------------------------------------ 101 ------ */

    start: {
      nav: 'Start Here',
      title: 'Start Here',
      level: null,
      body: `
        <p class="lead">This course teaches you to judge a liquidity pool before you put money
        in it, and to use Pool Lens to do the judging. It assumes you know what a liquidity pool
        is. It does not assume you want to do the arithmetic.</p>

        <h3>What you will be able to do</h3>
        <ul>
          <li>Tell whether a pool would have paid you more than simply holding the two tokens.</li>
          <li>Spot a token you cannot sell before you buy it.</li>
          <li>Work out how much to put in, given that gas is a fixed cost.</li>
          <li>Separate yield that survives from yield that stops when a campaign ends.</li>
        </ul>

        <h3>How it is arranged</h3>
        <p><strong>Pool Lens 101</strong> covers the ideas: what actually makes a liquidity
        position win or lose, and why the advertised APY rarely answers it. <strong>Using the
        tool</strong> turns those ideas into things you do on a screen. <strong>Going
        deeper</strong> covers ranges, exits and Pendle's fixed-yield markets.</p>

        <p>Each chapter is short and ends with the decision it is meant to help you make. You can
        read them in order or jump to the one matching the thing you are about to do.</p>

        <div class="cal cal-note">
          <strong>None of this is advice.</strong> Every threshold in this course is a starting
          point drawn from measurement, not a rule. Move them as you learn your own tolerance.
        </div>`
    },

    ch1: {
      nav: 'Chapter 1 - What makes an LP position win or lose',
      title: 'Chapter 1 — What makes an LP position win or lose',
      level: 'beginner',
      body: `
        <p class="lead">A liquidity provider has one job: end up with more than they would have
        had by doing nothing. Almost every number you will see quoted about a pool fails to
        answer whether that happened.</p>

        <h3>The only comparison that counts</h3>
        <p>When you provide liquidity you give up two tokens and receive a claim on a pool. The
        honest question is not "what APY did I earn" but <strong>"would I have been better off
        just keeping the two tokens"</strong>.</p>
        <p>A pool paying 40% in fees while the pair diverges 50% has lost you money. The 40% is
        real. It is also irrelevant on its own.</p>

        <h3>The three forces</h3>
        <ul>
          <li><strong>Fees</strong> are what you are paid, and they come from volume. More
            trading through a smaller pool means more fees per provider.</li>
          <li><strong>Impermanent loss</strong> is what the pool costs you when the two tokens
            move apart. It is not a fee anyone charges; it is a consequence of the pool
            rebalancing you into whichever asset is falling.</li>
          <li><strong>Costs</strong> are gas and slippage. They are fixed or near-fixed, which
            means they matter enormously on small positions and barely at all on large ones.</li>
        </ul>

        <h3>Impermanent loss is arithmetic, not a mystery</h3>
        <p>For a standard constant-product pool, the loss against holding depends only on how
        far the price ratio moved, not on the route it took:</p>
        <p class="formula">IL(r) = 2&radic;r / (1 + r) &minus; 1</p>
        <p>A doubling costs ${n('il2x')}. A fourfold move costs exactly ${n('il4x')}. A move and
        a full round trip back costs nothing at all — which is why a volatile pair that ends
        where it started can be a perfectly good position.</p>

        <div class="cal">
          <strong>The trade in one sentence.</strong> You are being paid fees to absorb
          divergence. The position works when the fees exceed what the divergence costs, and the
          only way to know is to measure both.
        </div>`,
      figure: 'impermanentLoss',
      takeaway: 'Judge every pool against holding the same two tokens. Fees, impermanent loss ' +
        'and fixed costs are the three forces, and only the comparison tells you who won.'
    },

    ch2: {
      nav: 'Chapter 2 - Reading a pool',
      title: 'Chapter 2 — Reading a pool',
      level: 'beginner',
      body: `
        <p class="lead">Four numbers tell you most of what you need about an established pool.
        Here is what each one means and what counts as good.</p>

        <h3>Volume against reserves (V/R)</h3>
        <p>Daily volume divided by pool size. It is the cleanest single measure of whether a pool
        is working, because fees come from volume and the same volume in a smaller pool pays each
        provider more.</p>
        <ul>
          <li>Around ${n('vrBenchmark')} is the benchmark this course uses.</li>
          <li>Well below it, the pool is quiet and the fees will disappoint whatever the
            headline says.</li>
          <li>Far above it — above about 5 — is usually looped or wash volume rather than
            genuine demand.</li>
        </ul>

        <h3>Fee APR</h3>
        <p>What the swap fees pay, annualised. Treat it as an extrapolation of recent volume,
        because that is what it is. It will not repeat exactly, and the app shows a second
        independent estimate beside it so you can read the pair as a range.</p>

        <h3>Impermanent loss over the window</h3>
        <p>Computed from the pool's own price history. The useful figure is the one next to it:
        the divergence at which fees stop covering the loss. Ask whether this pair moves that
        much in a month.</p>

        <h3>Earned versus paid</h3>
        <p>Yield splits into swap fees, which survive, and incentive tokens, which stop. A pool
        can advertise a large number that is almost entirely the second kind. Chapter 6 covers
        how to tell and what to do about it.</p>

        <div class="cal cal-note">
          <strong>Where to find these.</strong> Paste any pool into the
          <a href="index.html">analyser</a>. V/R and fee APR are near the top, impermanent loss
          in its own panel, and the earned/paid split lower down.
        </div>`,
      takeaway: 'V/R near 0.25 is the benchmark for a working pool. Fee APR is an ' +
        'extrapolation, not a promise. Always check how much of a yield is emissions.'
    },

    ch3: {
      nav: 'Chapter 3 - Is the pool real?',
      title: 'Chapter 3 — Is the pool real?',
      level: 'beginner',
      body: `
        <p class="lead">For anything outside the top few hundred pairs, this chapter matters more
        than the rest of the course. A yield figure is meaningless if you cannot sell.</p>

        <h3>Three kinds of evidence</h3>
        <ul>
          <li><strong>The contract.</strong> Honeypots, buy and sell taxes, mint authority,
            whether ownership can be reclaimed, hidden owners, self-destruct paths, pause and
            blacklist powers.</li>
          <li><strong>The trading.</strong> Genuine activity is many addresses trading a few
            times each, typically ${n('normalTrades')} trades per address. Manufactured volume
            is the reverse: a handful of addresses trading constantly. Above ${n('washTrades')}
            trades per address is worth a hard look.</li>
          <li><strong>The exit.</strong> What it actually costs to sell, at several sizes. This
            is the number a market cap cannot give you.</li>
        </ul>

        <h3>Buying with nobody selling</h3>
        <p>If a pool shows many buys and almost no sells — a ratio under ${n('honeypotSells')} —
        that is what a honeypot looks like from outside the contract, whatever the contract
        check reports. It is the single pattern most worth stopping for.</p>

        <h3>Why one red flag is not a verdict</h3>
        <p>USDT reports mintable, pausable, blacklist-capable, an active owner, and roughly half
        its supply held by ten addresses. Every one of those is true. On a memecoin that
        combination would be damning; on a regulated stablecoin it is the design, and in places
        the law.</p>
        <p>So severity comes from <strong>independent signals agreeing</strong>, not from any
        single flag. Mint authority on a token with fifteen million holders is context. The
        identical flag on a pool three days old with two liquidity providers is an emergency.</p>

        <div class="cal cal-warn">
          <strong>Nothing here ever says "safe".</strong> Contract checks read code, not intent.
          A contract with no dangerous powers can still belong to a project that walks away, the
          data can be stale, and a token deployed hours ago may have no record at all. A clean
          result means these checks found nothing, and no more.
        </div>`,
      takeaway: 'Check you can sell before you check what it pays. Severity comes from signals ' +
        'agreeing, never from one flag. A clean result is not a guarantee of safety.'
    },

    'takeaways-101': {
      nav: 'Pool Lens 101 - Key Takeaways',
      title: 'Pool Lens 101 — Key Takeaways',
      level: null,
      body: `
        <p class="lead">Everything from the first three chapters, in the order you would use it.</p>
        <div class="cal">
          <h4>The four that matter most</h4>
          <ul>
            <li><strong>Compare against holding, always.</strong> A yield figure alone cannot
              tell you whether you made money.</li>
            <li><strong>Check you can sell before you check what it pays.</strong></li>
            <li><strong>Impermanent loss is arithmetic.</strong> A 2&times; move costs
              ${n('il2x')}; a 4&times; move costs ${n('il4x')}; a round trip costs nothing.</li>
            <li><strong>V/R near ${n('vrBenchmark')}</strong> is the benchmark for a pool that
              is actually working.</li>
          </ul>
        </div>
        <h3>What you should be able to do now</h3>
        <ul>
          <li>Explain why a 40% APY can still be a losing position.</li>
          <li>Recognise the honeypot shape from trading data alone.</li>
          <li>Say why a mint-authority flag means different things on different tokens.</li>
        </ul>
        <p>The next section turns these into things you do on a screen.</p>`
    },

    /* -------------------------------------------------------- using it ------ */

    ch4: {
      nav: 'Chapter 4 - Before you enter a pool',
      title: 'Chapter 4 — Before you enter a pool',
      level: 'beginner',
      body: `
        <p class="lead">You have found a pool and you are about to provide liquidity. Five
        minutes, in this order. Each step is cheaper than the one after it.</p>

        <ol class="steps">
          <li><strong>Paste the link into the analyser.</strong>
            <p>Any front-end, or a bare pool address.</p></li>
          <li><strong>Read "Is this pool real?" first.</strong>
            <p>Anything critical and you stop here. On an established pair this comes back clean
            in seconds.</p></li>
          <li><strong>Check V/R against ${n('vrBenchmark')}.</strong>
            <p>Below it the pool is quiet. Far above it the volume is probably not real.</p></li>
          <li><strong>Look at fees against impermanent loss.</strong>
            <p>Find the divergence where fees stop covering the loss, and ask whether this pair
            moves that much.</p></li>
          <li><strong>Run the replay at your real position size.</strong>
            <p>"What it would actually have paid you" is the number that matters: better or
            worse off than holding.</p></li>
          <li><strong>Find out when the incentive stops.</strong>
            <p>If the yield depends on a campaign, you need its end date before you size for
            it.</p></li>
        </ol>

        <div class="cal">
          <h4>Decide</h4>
          <ul>
            <li><strong>Walk away</strong> on any critical finding, or if the replay shows
              holding would have beaten the pool over a period like the one you are planning.</li>
            <li><strong>Size down</strong> if V/R is under the benchmark, the campaign ends
              inside your horizon, or most of the yield is emissions.</li>
            <li><strong>Proceed</strong> when fees covered the loss over a comparable period and
              you have seen the exit cost at your size.</li>
          </ul>
        </div>`,
      takeaway: 'Safety, then activity, then the fee-versus-loss trade, then the replay at your ' +
        'real size. Stop at the first step that fails.'
    },

    ch5: {
      nav: 'Chapter 5 - Sizing the position',
      title: 'Chapter 5 — Sizing the position',
      level: 'beginner',
      body: `
        <p class="lead">How much to put in is not a smaller version of whether to put in. Costs
        behave differently at different sizes, and the difference is larger than most people
        expect.</p>

        <h3>Two costs pulling opposite ways</h3>
        <ul>
          <li><strong>Gas is fixed.</strong> Entering and leaving costs the same whether you
            bring $100 or $100,000, so as a percentage it shrinks as the position grows.</li>
          <li><strong>Slippage grows.</strong> The larger you are relative to the pool, the more
            you move the price getting in and out.</li>
        </ul>
        <p>Between them sits a floor: a smallest position worth opening at all. The analyser
        computes it and the gas figure is editable, because gas moves.</p>

        <h3>Your deposit dilutes the yield you are joining</h3>
        <p>A quoted APY belongs to the capital already in the pool. Adding yours makes the rate:</p>
        <p class="formula">your APR = APR &times; TVL / (TVL + your size)</p>
        <p>Below a percent or so of the pool this barely matters. Above a few percent you are
        meaningfully changing the thing you are buying.</p>

        <div class="cal cal-warn">
          <strong>How large the effect is.</strong> On one pool over one year, the identical
          position returned ${n('smallPosition')} at $500 and ${n('bigPosition')} at $1,000,000.
          Same pool, same window. The whole difference was that gas is a fixed cost.
        </div>

        <div class="cal">
          <h4>Decide</h4>
          <ul>
            <li>Below the minimum viable size, <strong>do not enter at all</strong> — not "enter
              smaller". The round trip costs more than the position earns back.</li>
            <li>Above a few percent of the pool, size down or split across pools.</li>
            <li>On a cheap chain the floor is small enough to ignore. On Ethereum at a busy
              moment it can be hundreds of dollars.</li>
          </ul>
        </div>`,
      figure: 'costCurve',
      takeaway: 'Gas is fixed and slippage is not, so there is a floor below which a position ' +
        'cannot pay for itself. Your own deposit dilutes the yield you are buying.'
    },

    ch6: {
      nav: 'Chapter 6 - Is this APY real?',
      title: 'Chapter 6 — Is this APY real?',
      level: 'intermediate',
      body: `
        <p class="lead">A number looks too good. Four checks tell you what is behind it.</p>

        <h3>Split earned from paid</h3>
        <p>Swap fees survive. Incentive tokens stop. A pool advertising a large number can be
        almost entirely the second kind, and the headline figure does not reveal it.</p>

        <h3>Find out when the campaign ends</h3>
        <p>This is the check most people skip, and the data says it matters most. Across 366 live
        incentive campaigns sampled, the median had ${n('campaignMedianDays')} left,
        ${n('campaignUnder30')} ended within thirty days, and only ${n('campaignOver180')} ran
        beyond a hundred and eighty.</p>
        <p>An annualised rate on a campaign with three weeks to run is not a rate anyone
        receives. A 40% APR with 21 days left is worth about 2.3% of capital, then it is gone.</p>

        <h3>Check how much the figure can be trusted</h3>
        <p>The confidence score rates the <em>number</em>, not the pool: how much history sits
        behind it, how volatile it has been, how far today sits from the recent mean. A thin or
        unstable figure deserves less weight than a lower, better-evidenced one.</p>

        <h3>Compare the sources</h3>
        <p>Two independent calculations of the same fee APR are shown side by side. When they
        disagree, treat the pair as a range rather than picking the one you prefer.</p>

        <div class="cal">
          <h4>Decide</h4>
          <ul>
            <li>Emissions above half the yield: price the position on the earned part and treat
              the rest as a bonus that will stop.</li>
            <li>Campaign ending inside your horizon: multiply the APR by the fraction of a year
              remaining. That is what you collect.</li>
            <li>Low confidence: prefer a lower, better-evidenced yield.</li>
          </ul>
        </div>`,
      takeaway: 'Most incentive campaigns have weeks left, not years. Price the position on ' +
        'earned yield and treat emissions as a bonus with an expiry date.'
    },

    ch7: {
      nav: 'Chapter 7 - Choosing between farms',
      title: 'Chapter 7 — Choosing between farms',
      level: 'intermediate',
      body: `
        <p class="lead">You have capital and no particular pool in mind. Narrow before you
        compare.</p>

        <ol class="steps">
          <li><strong>Start on <a href="explore.html">explore</a>, not the screener.</strong>
            <p>Decide the category and chain first. A lending market and a volatile LP position
            are not the same trade and should not be in the same list.</p></li>
          <li><strong>Pick a preset that matches your appetite.</strong>
            <p>Two of them come out of a backtest rather than out of an opinion.</p></li>
          <li><strong>Sort by earned yield, not headline APY.</strong>
            <p>In testing the two performed the same, but only one depends on emissions
            continuing.</p></li>
          <li><strong>Set a TVL floor.</strong>
            <p>A high yield on a tiny pool is a yield you cannot take at size.</p></li>
          <li><strong>Put the survivors through Chapter 4.</strong></li>
        </ol>

        <h3>What a backtest across ${n('backtestConfigs')} configurations found</h3>
        <ul>
          <li><strong>Concentration beat breadth.</strong> The top five consistently beat the top
            twenty. Spreading thin did not help.</li>
          <li><strong>The no-impermanent-loss sleeve never lost.</strong> Its worst result across
            every configuration was ${n('noIlWorst')}, against a dual-sided benchmark that
            reached ${n('dualBenchWorst')}. Lower ceiling, far more dependable.</li>
          <li><strong>Trying to dodge impermanent loss failed.</strong> Filtering to pairs that
            were not diverging was the worst rule tested, beating the benchmark in only
            ${n('calmPairsWins')} configurations.</li>
        </ul>

        <div class="cal cal-warn">
          <strong>Why that last one is the useful finding.</strong> Avoiding the volatility that
          causes impermanent loss also avoids the volume that pays fees. They are one phenomenon
          seen from two sides, and you cannot keep the income while filtering out the cause.
        </div>
        <p class="fine">Every backtest here is flattered by survivorship: the universe is pools
        that exist today with a year of history, so everything that died is absent.</p>`,
      takeaway: 'Narrow by category and chain first, sort by earned yield, concentrate rather ' +
        'than spread, and do not try to filter impermanent loss away.'
    },

    /* ----------------------------------------------------------- deeper ----- */

    ch8: {
      nav: 'Chapter 8 - Picking a range',
      title: 'Chapter 8 — Picking a range',
      level: 'advanced',
      body: `
        <p class="lead">Concentrated liquidity lets you put your capital where the trading is.
        It also lets you miss.</p>

        <h3>The trade</h3>
        <p>A narrower range multiplies the fees your capital earns while it is in range, and
        multiplies the chance of falling out of it. Out of range you earn nothing while still
        holding the divergence, which is the worst of both.</p>

        <h3>Use volume-weighted time, not the day count</h3>
        <p>Fees accrue on the share of <em>volume</em> that traded while you were in range, not
        the share of days. The busy days and the in-range days are frequently not the same days.</p>
        <div class="cal cal-warn">
          Using the day count instead overstated fees by about ${n('tauOverstate')} on a tight
          WETH/USDC range in testing. The app reports both and uses the volume-weighted figure.
        </div>

        <h3>Capital efficiency is knowable in advance</h3>
        <p>A range running from a quarter of the current price to four times it — written
        <code>P/4</code> to <code>4P</code> — is exactly twice as capital-efficient as full
        range. The <a href="amm.html">AMM demo</a> lets you check that by hand rather than taking
        it on trust.</p>
        <p class="fine">Worth stating precisely, because "a four-times range" is ambiguous: it
        can mean four times either side of the price, as here, or a span four times wide, which
        is a different and much narrower range.</p>

        <div class="cal">
          <h4>Decide</h4>
          <ul>
            <li>Pick the widest range that still earns what you need. Width is the cheap form of
              insurance.</li>
            <li>If the backtest shows the price leaving your range repeatedly, you are choosing
              a management job, not a position — price the rebalancing gas into Chapter 5.</li>
          </ul>
        </div>`,
      figure: 'rangeEfficiency',
      takeaway: 'Narrow ranges earn more and miss more. Judge them on volume-weighted time in ' +
        'range, and price the rebalancing you are signing up for.'
    },

    ch9: {
      nav: 'Chapter 9 - Managing and exiting',
      title: 'Chapter 9 — Managing and exiting',
      level: 'intermediate',
      body: `
        <p class="lead">You already hold the position and something has changed.</p>

        <ol class="steps">
          <li><strong>Save it to <a href="book.html">your book</a> with your real entry
            price.</strong>
            <p>The book ranks positions by which needs attention.</p></li>
          <li><strong>Re-run the replay from your entry date, not from today.</strong>
            <p>The question is what has happened since you entered.</p></li>
          <li><strong>Check whether the pool is draining.</strong>
            <p>A pool losing both volume and TVL usually does not come back.</p></li>
          <li><strong>Price the exit before deciding.</strong>
            <p>Leaving costs gas and slippage. Sometimes the honest answer is that you are past
            the point where exiting helps.</p></li>
        </ol>

        <div class="cal">
          <h4>Decide</h4>
          <ul>
            <li><strong>Exit</strong> if the range is broken and you are not rebalancing, the
              incentive that justified the position has ended, or volume has collapsed.</li>
            <li><strong>Hold</strong> if fees still cover divergence and the exit costs more
              than it saves.</li>
            <li><strong>Set an alert rather than watching.</strong> Range breaks, volume falling
              below the benchmark, dilution and campaign expiry can all be watched for you.</li>
          </ul>
        </div>

        <div class="cal cal-warn">
          <strong>On sunk cost.</strong> The replay tells you what happened, which is not what
          will happen. Use it to judge whether the thesis held, not to chase a loss back.
        </div>`,
      takeaway: 'Re-run from your entry date, not today. Exit on a broken thesis, not on a bad ' +
        'week, and price the exit before taking it.'
    },

    ch10: {
      nav: 'Chapter 10 - Fixed yield on Pendle',
      title: 'Chapter 10 — Fixed yield on Pendle',
      level: 'advanced',
      body: `
        <p class="lead">Paste a Pendle market and the page looks completely different. That is
        deliberate: it is a different trade.</p>

        <h3>Why the usual panels disappear</h3>
        <p>A Pendle pool trades a principal token against its yield-bearing wrapper. The PT
        converges to par at expiry by construction, so "impermanent loss against holding" is the
        wrong question. Those panels are not shown rather than shown wrong.</p>

        <h3>What to read instead</h3>
        <ul>
          <li><strong>Implied yield against the underlying rate.</strong> The spread between the
            fixed rate you can lock and the floating rate the asset actually earns is the
            trade.</li>
          <li><strong>Time to expiry.</strong> Every figure on the page decays toward it.</li>
          <li><strong>The LP yield split.</strong> Swap fees and accrued yield are shown
            separately from PENDLE emissions, with the vePENDLE boost as a visible multiple
            rather than folded in.</li>
        </ul>

        <div class="cal">
          <h4>Decide</h4>
          <ul>
            <li><strong>Hold PT</strong> to lock the fixed rate, when implied yield is above
              what you expect the floating rate to average.</li>
            <li><strong>Hold YT</strong> for the floating leg when you think the opposite.</li>
            <li><strong>Provide liquidity</strong> when you want the fees and are comfortable
              sitting between the two.</li>
            <li>Outside the 0.1 to 0.9 proportion band from the Pendle V2 paper, quotes move
              fast.</li>
          </ul>
        </div>
        <p class="fine">Cross-checked: across 45 live Ethereum markets, the implied yield shown
        here differed from Pendle's own published figure by a median of ${n('pendleGap')}.</p>`,
      takeaway: 'Pendle is a rates trade, not a spot one. Compare implied against underlying ' +
        'yield, watch the expiry, and choose PT, YT or LP from that spread.'
    },

    'takeaways-advanced': {
      nav: 'Optimizing with Pool Lens - Key Takeaways',
      title: 'Optimizing with Pool Lens — Key Takeaways',
      level: null,
      body: `
        <p class="lead">The whole course, compressed.</p>
        <div class="cal">
          <h4>If you remember four things</h4>
          <ul>
            <li><strong>Compare against holding, always.</strong></li>
            <li><strong>Check you can sell before you check what it pays.</strong></li>
            <li><strong>Size matters more than you think.</strong> Gas is fixed, your deposit
              dilutes the yield, slippage grows with the position.</li>
            <li><strong>Ask when the yield stops.</strong> Most campaigns have weeks left.</li>
          </ul>
        </div>
        <h3>The findings that surprised people</h3>
        <ul>
          <li>Trying to avoid impermanent loss by picking quiet pairs was the worst strategy
            tested — it also avoids the fees.</li>
          <li>The same position returned ${n('smallPosition')} at $500 and ${n('bigPosition')}
            at $1,000,000 in the same pool over the same year.</li>
          <li>The median incentive campaign has ${n('campaignMedianDays')} left, not years.</li>
          <li>Counting days instead of volume overstated range fees by ${n('tauOverstate')}.</li>
        </ul>
        <h3>What this course cannot give you</h3>
        <p>None of it is advice. Backtests are flattered by survivorship, concentrated-pool
        yields are upper bounds, and contract checks read code rather than intent. The
        <a href="docs.html">docs</a> list the limits in full.</p>`
    },

    cheatsheet: {
      nav: 'Thresholds Cheatsheet',
      title: 'Thresholds Cheatsheet',
      level: null,
      body: `
        <p class="lead">Every number this course uses, in one place. Starting points, not laws.</p>
        <div class="table-scroll"><table>
          <thead><tr><th>Signal</th><th class="num">Threshold</th><th>What it means</th></tr></thead>
          <tbody>
            <tr><td>V/R (volume &divide; reserves)</td><td class="num">0.25</td>
              <td class="muted">The benchmark for a pool that is actually working</td></tr>
            <tr><td>V/R, upper</td><td class="num">5</td>
              <td class="muted">Above this is usually looped or wash volume</td></tr>
            <tr><td>Impermanent loss, 2&times; move</td><td class="num">&minus;5.72%</td>
              <td class="muted">Against holding. Path-independent</td></tr>
            <tr><td>Impermanent loss, 4&times; move</td><td class="num">&minus;20%</td>
              <td class="muted">Exactly, by the closed form</td></tr>
            <tr><td>Emissions share</td><td class="num">50%</td>
              <td class="muted">Above this, price the position on earned yield alone</td></tr>
            <tr><td>Campaign life remaining</td><td class="num">21 days</td>
              <td class="muted">The median across 366 live campaigns</td></tr>
            <tr><td>Trades per address</td><td class="num">1.5&ndash;2.5</td>
              <td class="muted">Normal. Above 12 suggests manufactured volume</td></tr>
            <tr><td>Sells per buy</td><td class="num">0.1</td>
              <td class="muted">Below this is the honeypot shape</td></tr>
            <tr><td>Confidence score</td><td class="num">50</td>
              <td class="muted">Below this the figure is thin or unstable</td></tr>
            <tr><td>Your share of the pool</td><td class="num">~3%</td>
              <td class="muted">Above this your own deposit moves the yield materially</td></tr>
            <tr><td>Pendle proportion band</td><td class="num">0.1&ndash;0.9</td>
              <td class="muted">Outside it, quotes move fast</td></tr>
          </tbody>
        </table></div>
        <p class="fine">Each figure is either from the course notes this project was built
        against, from the backtest in the repository, or measured from live pools. Where a number
        came from measurement, the chapter that uses it says so.</p>`
    }
  };

  /* ------------------------------------------------------------------ router */

  const ORDER = SECTIONS.flatMap((s) => s.chapters);

  const levelLabel = { beginner: '#beginner', intermediate: '#intermediate',
                       advanced: '#advanced' };

  function currentId() {
    const h = String(location.hash || '').replace(/^#/, '');
    return CHAPTERS[h] ? h : 'start';
  }

  function renderSidebar(active) {
    return SECTIONS.map((s) => `
      <div class="ac-group">
        <div class="ac-group-title"><span class="ac-ico">${esc(s.icon)}</span>${esc(s.title)}</div>
        <ul>
          ${s.chapters.map((id) => `
            <li><a href="#${id}" class="${id === active ? 'on' : ''}">${esc(CHAPTERS[id].nav)}</a></li>
          `).join('')}
        </ul>
      </div>`).join('');
  }

  function renderChapter(id) {
    const c = CHAPTERS[id];
    const i = ORDER.indexOf(id);
    const prev = i > 0 ? ORDER[i - 1] : null;
    const next = i < ORDER.length - 1 ? ORDER[i + 1] : null;
    const section = SECTIONS.find((s) => s.chapters.includes(id));

    return `
      <div class="ac-crumb">${esc(section ? section.title : '')}</div>
      <h1>${esc(c.title)}</h1>
      ${c.level ? `<div class="ac-level">Course level: <strong>${levelLabel[c.level]}</strong></div>` : ''}
      <div class="ac-body">${c.body}${
        c.figure && LP.academyFigures && LP.academyFigures[c.figure]
          ? LP.academyFigures[c.figure]() : ''}</div>
      ${c.takeaway ? `<div class="cal cal-take"><h4>Takeaway</h4><p>${c.takeaway}</p></div>` : ''}
      <nav class="ac-pager">
        ${prev ? `<a href="#${prev}" class="prev"><span>Previous</span>${esc(CHAPTERS[prev].nav)}</a>`
               : '<span></span>'}
        ${next ? `<a href="#${next}" class="next"><span>Next</span>${esc(CHAPTERS[next].nav)}</a>`
               : '<span></span>'}
      </nav>`;
  }

  function draw() {
    const id = currentId();
    const side = document.getElementById('acSidebar');
    const main = document.getElementById('acMain');
    if (side) side.innerHTML = renderSidebar(id);
    if (main) {
      main.innerHTML = renderChapter(id);
      main.scrollIntoView({ block: 'start' });
    }
    document.title = CHAPTERS[id].title + ' | Pool Lens Academy';
    const open = document.getElementById('acToggle');
    if (open) open.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('ac-open');
  }

  function init() {
    draw();
    window.addEventListener('hashchange', draw);
    const t = document.getElementById('acToggle');
    if (t) t.addEventListener('click', () => {
      const open = document.body.classList.toggle('ac-open');
      t.setAttribute('aria-expanded', String(open));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }

  return { CHAPTERS, SECTIONS, ORDER, NUMBERS, draw, currentId };
})();
