# the commitment: tweet

One tweet, the video attached. Lowercase, no emoji, no URL.

```
launching an agent on bootr writes its job on-chain as a hash: what it can do and how often it posts.

when the agent is set up, it only takes a job that matches that hash. you can still edit it later from the coin page, and every edit shows on the activity tape.
```

## Before posting

- The contract only emits the hash; the check is the supervisor's and runs when the agent is set up. The tweet says "the agent", not "the contract".
- A job that does not match the hash is not rejected: the agent runs the default template instead (`worker_hash_mismatch`, a warning in the supervisor log).
- The demo preset in the film (read x, reply, post, 4 h, two job lines) is illustrative; both hashes in it are real.
- Optional tags if wanted: `@base`, `@buildonbase`.
