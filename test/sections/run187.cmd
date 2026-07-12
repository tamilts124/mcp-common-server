@echo off
node test/sections/187-udp-client.js > test\sections\187-out.txt 2>&1
echo EXIT:%ERRORLEVEL% >> test\sections\187-out.txt
