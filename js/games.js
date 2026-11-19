/**
 * Game generator. A JavaScript port of the old makegame.php, so the page works
 * as a static site (GitHub Pages) without PHP or a database.
 *
 * Every game number has a fixed random seed: game 3 is always the same dice
 * sequence, on any device, so a refresh or a second screen stays in sync.
 *
 * Turn shapes (unchanged from games.json):
 *   { id, 1: die1, 2: die2, side: "SUN"|"MOON" }      normal roll
 *   { id: 0, event: "robber", result: "active" }       robber becomes active
 *   { id: 0, event: "robber", result: <number>, side } robber strikes a number
 */
(function () {
    "use strict";

    // The old catan_dicepool table: a "deck" of 36 dice results. Id = index + 1.
    const DICE_POOL = [
        [3, 3], [3, 6], [1, 3], [2, 3], [3, 2], [6, 2], [2, 2], [6, 4], [5, 5],
        [4, 5], [4, 4], [3, 4], [3, 1], [2, 1], [5, 6], [5, 4], [3, 5], [4, 1],
        [6, 1], [4, 2], [1, 2], [3, 5], [1, 4], [6, 1], [2, 6], [5, 6], [1, 5],
        [5, 2], [4, 2], [4, 6], [1, 5], [1, 1], [6, 6], [4, 3], [5, 2], [3, 6],
    ];

    const ROUNDS_PER_GAME = 50;
    const DRAWS_PER_ROUND = 31;   // cards drawn from the 36-card deck each round
    const ROBBER_ACTIVE_AT = 16;  // draw number in round 1 that activates the robber

    // Small seeded PRNG (mulberry32) so a game number always gives the same game.
    function seededRandom(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function drawRound(random) {
        const deck = DICE_POOL.map(([d1, d2], i) => ({ id: i + 1, d1, d2 }));
        for (let i = deck.length - 1; i > 0; i--) {          // Fisher–Yates
            const j = Math.floor(random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        return deck.slice(0, DRAWS_PER_ROUND);
    }

    function generate(gameNumber) {
        const random = seededRandom(Math.imul(gameNumber, 0x9e3779b1) ^ 0x5eed);
        let side = "MOON";
        const nextSide = () => (side = side === "SUN" ? "MOON" : "SUN");

        const rounds = [];
        for (let r = 0; r < ROUNDS_PER_GAME; r++) {
            const turns = [];
            let robberPending = false;

            drawRound(random).forEach(({ id, d1, d2 }, i) => {
                const draw = i + 1;
                // Same rule order as makegame.php:
                // 1) round 1, draw 16: the robber becomes active (the card is discarded)
                if (r === 0 && draw === ROBBER_ACTIVE_AT) {
                    turns.push({ id: 0, event: "robber", result: "active" });
                    return;
                }
                // 2) a 7 once the robber is active: the next card decides where the robber strikes
                if (d1 + d2 === 7 && (r > 0 || draw > ROBBER_ACTIVE_AT)) {
                    robberPending = true;
                    return;
                }
                // 3) the card after a 7 becomes a robber turn
                if (robberPending) {
                    turns.push({ id: 0, event: "robber", result: d1 + d2, side: nextSide() });
                    robberPending = false;
                    return;
                }
                // 4) normal roll
                turns.push({ id, 1: d1, 2: d2, side: nextSide() });
            });
            rounds.push(turns);
        }
        return rounds;
    }

    const cache = new Map();
    window.CatanGames = {
        MAX_GAME: 9999,
        get(gameNumber) {
            const n = Math.floor(Number(gameNumber));
            if (!(n >= 1 && n <= this.MAX_GAME)) return null;
            if (!cache.has(n)) cache.set(n, generate(n));
            return cache.get(n);
        },
    };
})();
