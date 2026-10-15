/** @jest-environment node */
/* eslint-env jest */
import { AdminConfig } from './admin.types';
import { getAvailableApiSites, refineConfig, setCachedConfig } from './config';

jest.mock('./db', () => ({ db: {} }));

const source = {
  key: 'demo',
  name: '源',
  api: 'csp_Demo',
  protocol: 'csp' as const,
  runnerSite: 'runner-demo',
  spider: 'https://example.com/spider.jar',
  ext: { token: 'demo' },
  siteType: 3,
};

function makeConfig(): AdminConfig {
  return {
    ConfigFile: JSON.stringify({ api_site: { demo: source } }),
    ConfigSubscribtion: { URL: '', AutoUpdate: false, LastCheck: '' },
    SourceConfig: [{ ...source, from: 'config', disabled: true }],
    UserConfig: {
      Users: [
        { username: 'direct', role: 'user', enabledApis: ['demo'] },
        { username: 'tagged', role: 'user', tags: ['group'] },
      ],
      Tags: [{ name: 'group', enabledApis: ['demo'] }],
    },
    CustomCategories: [],
    LiveConfig: [],
    SiteConfig: {} as AdminConfig['SiteConfig'],
  };
}

test('配置更新保留协议元数据和禁用状态，所有权限分支均返回协议字段', async () => {
  const oldRunner = process.env.SOURCE_RUNNER_URL;
  const oldToken = process.env.SOURCE_RUNNER_TOKEN;
  delete process.env.SOURCE_RUNNER_URL;
  delete process.env.SOURCE_RUNNER_TOKEN;
  try {
    const config = refineConfig(makeConfig());
    expect(config.SourceConfig[0]).toMatchObject({
      ...source,
      disabled: true,
      runtimeStatus: 'runtime_unconfigured',
    });
    config.SourceConfig[0].disabled = false;
    await setCachedConfig(config);
    for (const user of [undefined, 'direct', 'tagged', 'unknown']) {
      expect(await getAvailableApiSites(user)).toEqual([]);
    }
    process.env.SOURCE_RUNNER_URL = 'https://example.com/runner';
    expect(await getAvailableApiSites('direct')).toEqual([]);
    process.env.SOURCE_RUNNER_TOKEN = 'test-token';
    for (const user of [undefined, 'direct', 'tagged', 'unknown']) {
      expect(await getAvailableApiSites(user)).toEqual([
        expect.objectContaining({ ...source, runtimeStatus: undefined }),
      ]);
    }
    config.SourceConfig.push({
      key: 'cms',
      name: 'CMS',
      api: 'https://example.com/api',
      from: 'custom',
    });
    config.SourceConfig.push({
      ...source,
      key: 'unsupported',
      siteType: 4,
      from: 'custom',
    });
    delete process.env.SOURCE_RUNNER_URL;
    expect(await getAvailableApiSites()).toEqual([
      expect.objectContaining({ key: 'cms' }),
    ]);
  } finally {
    if (oldRunner === undefined) delete process.env.SOURCE_RUNNER_URL;
    else process.env.SOURCE_RUNNER_URL = oldRunner;
    if (oldToken === undefined) delete process.env.SOURCE_RUNNER_TOKEN;
    else process.env.SOURCE_RUNNER_TOKEN = oldToken;
  }
});
