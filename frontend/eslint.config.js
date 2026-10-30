import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default ts.config(
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['src/**/*.test.ts'],
    // A single test file may declare several isolated Vue mock components.
    rules: { 'vue/one-component-per-file': 'off' },
  },
  {
    files: ['src/**/*.{ts,vue}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { parser: ts.parser, extraFileExtensions: ['.vue'] },
    },
    rules: {
      'vue/multi-word-component-names': ['error', { ignores: ['App'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  prettier,
);
