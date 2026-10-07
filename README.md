# NYANLOTTO

$NYAN is the lottery coin. The prize is $PLTR, paid as PLTRx (Palantir xStock, `XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4`) on Solana.

A buy of $NYAN resets a 60-second clock and becomes the last buyer. A buy is a wallet that gains $NYAN and spends SOL or $PLTR. When 60 seconds pass with no new buy, that wallet wins.

Pump.fun fees sit in the treasury as SOL. 0.05 SOL never leaves. SOL above that reserve, minus a small fee buffer, is swapped to PLTRx and sent to the last buyer. PLTRx already in the treasury is sent first.

The clock starts working after both of these are set:

```
# base58 secret key, or a JSON byte array. Never commit this.
wrangler secret put TREASURY_SECRET
```

Set the launched mint in `wrangler.toml` as `NYAN_MINT`, and `TREASURY_PUBKEY` if you want the pot visible before the signing key is installed. `HELIUS_API_KEY` is optional and is the better RPC once holder traffic shows up.

`npm test` checks the clock, the buy rule, and the reserve. `npx wrangler deploy` publishes the worker.
