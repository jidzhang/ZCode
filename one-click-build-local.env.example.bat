rem Template for one-click-build-local.env.bat (gitignored, never committed).
rem Copy this file to one-click-build-local.env.bat and edit BUILD_PROXY.
rem
rem Binary downloads (electron, NSIS, winCodeSign) go through BUILD_PROXY with
rem npmmirror mirrors. Leave BUILD_PROXY empty - or do not create the env file
rem at all - for direct connection with the default download sources.
set BUILD_PROXY=
