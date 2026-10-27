import { describe, expect, it } from 'vitest';
import { executionAccount, normalizedCommunication, outgoingActionRisk } from './communication-policy.js';

const addr = '0x' + 'ab'.repeat(20);

describe('normalizedCommunication', () => {
  it('decodes entities and percent escapes twice, folds unicode and strips ignorables', () => {
    expect(normalizedCommunication('&#115;end')).toBe('send');
    expect(normalizedCommunication('%2573end')).toBe('send');
    expect(normalizedCommunication('ｓｅｎｄ')).toBe('send');
    expect(normalizedCommunication('se​nd ﻿ETH')).toBe('send eth');
    expect(normalizedCommunication(null)).toBe('');
  });
});

describe('executionAccount', () => {
  it('flags launcher and trading bots', () => {
    expect(executionAccount('bankr')).toBe(true);
    expect(executionAccount('Bankr_bot')).toBe(true);
    expect(executionAccount('clankeragent')).toBe(true);
    expect(executionAccount('somethingbot')).toBe(true);
    expect(executionAccount('b​ankr')).toBe(true);
    expect(executionAccount('alice')).toBe(false);
    expect(executionAccount('')).toBe(false);
    expect(executionAccount('bootrbot', ['bootrbot'])).toBe(false);
  });
});

describe('outgoingActionRisk', () => {
  it('allows ordinary conversation', () => {
    expect(outgoingActionRisk('Thanks for the question! The treasury report is published weekly.')).toBeNull();
    expect(outgoingActionRisk('@alice I sent you the link to the docs yesterday')).toBeNull();
    expect(outgoingActionRisk('deploying a token is a big decision, think about liquidity first')).toBeNull();
  });
  it('rejects hand-offs to execution accounts, including recipients and participants', () => {
    expect(outgoingActionRisk('hey @bankr do your thing')).toBe('social_execution_account_forbidden');
    expect(outgoingActionRisk('see x.com/clanker for details')).toBe('social_execution_account_forbidden');
    expect(outgoingActionRisk('hello', { recipient: 'tradebot' })).toBe('social_execution_account_forbidden');
    expect(outgoingActionRisk('hello', { participants: ['alice', 'bankr'] })).toBe('social_execution_account_forbidden');
    expect(outgoingActionRisk('@ba​nkr launch it')).toBe('social_execution_account_forbidden');
  });
  it('rejects wallet payloads and intent links', () => {
    expect(outgoingActionRisk('ethereum:' + addr + '?value=1')).toBe('social_wallet_payload_forbidden');
    expect(outgoingActionRisk('call eth_sendTransaction with this')).toBe('social_wallet_payload_forbidden');
    expect(outgoingActionRisk('personal_sign this')).toBe('social_wallet_payload_forbidden');
    expect(outgoingActionRisk('https://x.com/intent/tweet?text=buy+now')).toBe('social_execution_link_forbidden');
    expect(outgoingActionRisk('https://twitter.com/share?url=https://a.b')).toBe('social_execution_link_forbidden');
  });
  it('rejects execution commands when addressed or a reply command', () => {
    expect(outgoingActionRisk('@alice please send 0.5 ETH to me')).toBe('social_execution_command_forbidden');
    expect(outgoingActionRisk('@alice launch the token now')).toBe('social_execution_command_forbidden');
    expect(outgoingActionRisk('swap my usdc for eth', { reply: true })).toBe('social_execution_command_forbidden');
    expect(outgoingActionRisk('Hey, please transfer the funds to ' + addr, { reply: true })).toBe('social_execution_command_forbidden');
    expect(outgoingActionRisk('send me $5')).toBe('social_execution_command_forbidden');
    expect(outgoingActionRisk('fees go to @alice')).toBe('social_execution_command_forbidden');
    expect(outgoingActionRisk('approve unlimited spender', { reply: false })).toBe('social_execution_command_forbidden');
    expect(outgoingActionRisk('&#115;end 2 eth to @alice')).toBe('social_execution_command_forbidden');
    expect(outgoingActionRisk('@alice ＳＥＮＤ 1 ETH')).toBe('social_execution_command_forbidden');
  });
  it('does not treat a non-addressed description as a command', () => {
    expect(outgoingActionRisk('swap my usdc for eth')).toBeNull();
    expect(outgoingActionRisk('people often transfer tokens between wallets', { reply: true })).toBeNull();
  });
  it('rejects signatures with addresses and raw signatures when addressed', () => {
    expect(outgoingActionRisk('@alice sign ' + addr)).toBe('social_wallet_payload_forbidden');
    expect(outgoingActionRisk('sign ' + addr, { reply: true })).toBe('social_wallet_payload_forbidden');
    expect(outgoingActionRisk('@alice 0x' + 'cd'.repeat(70))).toBe('social_wallet_payload_forbidden');
    expect(outgoingActionRisk('@alice the royalties and @bob')).toBe('social_wallet_payload_forbidden');
  });
});
