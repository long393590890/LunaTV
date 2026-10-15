/* eslint-env jest */
import { generateStorageKey, splitStorageKey } from './storage-key';

test.each([
  ['a+b+c', ['a', 'b+c']],
  ['a+b/c+d==', ['a', 'b/c+d==']],
  ['source+42122/52', ['source', '42122/52']],
  [
    'source+https://a.test/v?x=1+2&y=3#f',
    ['source', 'https://a.test/v?x=1+2&y=3#f'],
  ],
  ['a', ['a', '']],
  ['', ['', '']],
  ['+id', ['', 'id']],
  ['a+', ['a', '']],
  ['a++', ['a', '+']],
])('按首个加号拆分存储键 %s', (key: string, expected: string[]) => {
  expect(splitStorageKey(key)).toEqual(expected);
});

test('存储键保留原始影片ID并可无损往返', () => {
  const id = 'folder/a+b+c%2F?x=1&y=中文';
  const key = generateStorageKey('source', id);
  expect(key).toBe(`source+${id}`);
  expect(splitStorageKey(key)).toEqual(['source', id]);
  const query = new URLSearchParams(`key=${encodeURIComponent(key)}`);
  expect(splitStorageKey(query.get('key') as string)).toEqual(['source', id]);
});
