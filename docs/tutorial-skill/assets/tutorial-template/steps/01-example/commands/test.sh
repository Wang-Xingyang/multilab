#!/bin/bash
set -e
gcc main.c -o /tmp/test_main.out -Wall 2>/tmp/err.txt || {
  echo "编译失败:" >&2
  cat /tmp/err.txt >&2
  exit 1
}
output=$(/tmp/test_main.out)
if echo "$output" | grep -q "Hello"; then
  echo "PASS"
  exit 0
else
  echo "FAIL: 输出不含 Hello" >&2
  exit 1
fi
