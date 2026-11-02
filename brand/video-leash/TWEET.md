Thread for the film (lowercase, no emoji). Attach `renders/the-leash.mp4` to the first post.

1/
every coin on bootr has an agent that holds real money: usdc, weth and eth in a smart account on base.

what signs for it is a session key. the key can make six calls. nothing else.

2/
the six:
- claim fees, only into the agent's own account
- approve and swap weth to usdc through one swap helper
- send usdc to its own spender, 50 a day at most
- unwrap weth to eth for gas

every call carries zero eth. delegatecall fails.

3/
anything off the list never executes. it fails validation as PolicyFailed.

a swap gets past the call policy and meets a second wall: the swap helper's floor is the chainlink price, 3% off at most. ask for 10% and it reverts SlippageTooHigh(1000, 300).

4/
and the key can be stopped three ways:
- it expires after 30 days
- the creator can pause the agent
- the platform can revoke every key in one transaction

the agent holds the money. the key holds six calls.

smart accounts on @base (erc-4337). @buildonbase
