// Distinguish effort changes from availability declarations; this does not edit a plan.
export function isDraftEditText(text: string) {
  return /(?:改|调整|缩短|增加|减少).*(?:分钟|每次|每周|频次|时长)|第\s*[一二三四五六1-6].*(?:项|任务|步骤)/u.test(
    text.replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    ),
  );
}
