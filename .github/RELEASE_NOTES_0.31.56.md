# 0.31.56

提示词里唯一会变的那块挪到最后，前缀缓存这才开始起作用。

## 问题

用户消息的第一块是草稿，而草稿每敲一个字就变。模型按**前缀**命中缓存，所以后面那一大段（transcript、digest、风格、助手上一句、语言指令）每次全部失效。

实测同内容只换顺序：

```
布局          prompt  命中  未命中
草稿在前         814     0     814   （0%）
草稿在后         817   512     305   （63%）
```

改后第一次仍为 0（缓存冷），之后每次命中 512 tokens。用真实 builder 复测 5 次（草稿逐次加长模拟打字），第一次之后稳定 67%。

## 改法

把草稿挪到 user 消息的最后，前面保持稳定。**没有改任何规则措辞**，只换了顺序。短稿模板同样处理。

命中价是未命中的 1/50，所以输入成本大约降到原来的三分之一，延迟也会降——缓存部分不用重新 prefill。

## 以后的约定

往提示词里加东西，一律加在草稿**之前**。唯一的例外是草稿本身。

## 测试

```
单测  132
场景  55/55
```

---

[CHANGELOG](https://github.com/yugyq/dsh-composer-quill/blob/main/CHANGELOG.md) ｜ [缓存实验](https://github.com/yugyq/dsh-composer-quill/blob/main/dev/cache-probe.mjs) ｜ [npm](https://www.npmjs.com/package/dsh-composer-quill)
