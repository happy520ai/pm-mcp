# ADR-004 语义治理采用AST保证分层与运行时证据扩展

- 日期: 2026-09-03
- 状态: 已接受

## 背景

正则启发式无法可靠区分代码与文本，也不能提供可声明的语义覆盖和来源证明。

## 决定

TS/JS使用TypeScript Compiler API，Python/Go/Rust/Java/Kotlin/C#使用固定Tree-sitter grammar；严格策略要求AST并禁止fallback；动态行为通过绑定源码哈希的runtime evidence补充。

## 后果

新增固定运行时依赖与解析成本；AST仍不证明真实执行，要求runtime等级时缺trace会失败。
