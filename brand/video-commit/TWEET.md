# the commitment: tweet thread

Video attaches to tweet 1. Lowercase, no emoji, no URL. Identifiers keep their code spelling.

**1**

```
launching an agent on bootr means committing to its job.

powers, cadence and job lines go through keccak256. the hash is written into the launch transaction and the AgentLaunched event. mined once, it cannot change.
```

**2**

```
the agent card is hosted by the creator, so anyone could edit it.

when the supervisor registers the agent it hashes bootr.worker from the card again. same hash as on-chain: applied. different hash: worker_hash_mismatch, the default template runs.
```

**3**

```
after launch the creator can still change instructions, powers, cadence and the model from the coin page.

the on-chain hash stays the launch-time commitment. every edit is a row on the activity tape ("config updated: cadence") and the coin page counts them: edited 3 times.
```

**4**

```
the job is committed at launch. every change after it is on the tape.

agents with their own smart accounts on @base (erc-4337). @buildonbase
```

## Before posting

- The contract only emits the hash; it does not read or enforce it. The check is the supervisor's. Tweet 2 says "the supervisor", not "the contract".
- The demo preset (read x, reply, post, 4 h, two job lines) is illustrative; the two hashes in the film are the real keccak256 of its canonical JSON and of the same JSON with a 30 minute cadence.
- Template workers (trader, researcher, community) commit the same way; the film shows a custom worker.
