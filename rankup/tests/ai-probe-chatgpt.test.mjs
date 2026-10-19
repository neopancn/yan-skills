import assert from 'node:assert/strict';
import test from 'node:test';
import { temporaryPageNotice } from '../scripts/demand/_chatgpt_web.mjs';

const url = 'https://chatgpt.com/?temporary-chat=true';
test('temporary URL plus Chinese or English notice/banner passes without a personalization menu', () => {
  for (const text of ['此聊天不会使用记忆、插件和自定义指令，且不会显示在你的历史记录中', '临时聊天', 'Temporary Chat', "This chat won't use memories", 'This chat does not use memory']) {
    assert.equal(temporaryPageNotice({ url, text }), text);
    assert.equal(temporaryPageNotice({ url, text, mode: '个性化' }), text);
  }
});
test('ordinary page, missing declaration, wrong origin and false query never pass', () => {
  for (const page of [
    { url: 'https://chatgpt.com/', text: '临时聊天' },
    { url, text: '正在加载个人资料' },
    { url: 'https://chatgpt.com/?temporary-chat=false', text: '临时聊天' },
    { url: 'https://example.com/?temporary-chat=true', text: '临时聊天' },
    { url: 'invalid', text: '临时聊天' },
    { url, text: 'How do I start a Temporary Chat?' },
  ]) assert.equal(temporaryPageNotice(page), '');
});
