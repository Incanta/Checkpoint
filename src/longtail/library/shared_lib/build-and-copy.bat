@echo off

call build.bat
call build.bat release

if %errorlevel% neq 0 exit /b %errorlevel%

cd ..

call dist.bat

rm -rf ../addon/src/longtail
cp -r dist ../addon/src/longtail
