const jestConfig = {
  displayName: 'agent-runtime',
  rootDir: './',
  testEnvironment: 'node',
  clearMocks: true,
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          target: 'es2021',
        },
      },
    ],
  },
};

export default jestConfig;
