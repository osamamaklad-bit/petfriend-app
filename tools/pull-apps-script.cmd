@echo off
rem Pet Friend: copy the code edited in the Google Apps Script editor into this repository and push it to GitHub.
rem Run it from the repository folder:   tools\pull-apps-script.cmd
rem Needs: Node.js, Git, and clasp (npm install -g @google/clasp, then clasp login once).
rem The Script ID is in Apps Script: Project Settings > IDs > Script ID (it is not a secret).
setlocal
cd /d "%~dp0.."
if "%PF_SCRIPT_ID%"=="" set /p PF_SCRIPT_ID=Script ID: 
if "%PF_SCRIPT_ID%"=="" (echo No Script ID given. & exit /b 1)

echo.
echo 1/5  Getting the latest version from GitHub...
git pull || (echo git pull failed: fix it, then run this again. & exit /b 1)

echo 2/5  Downloading the code from Apps Script...
set "PF_TMP=%TEMP%\petfriend-clasp"
if exist "%PF_TMP%" rmdir /s /q "%PF_TMP%"
mkdir "%PF_TMP%"
> "%PF_TMP%\.clasp.json" echo {"scriptId":"%PF_SCRIPT_ID%"}
pushd "%PF_TMP%"
call clasp pull || (popd & echo clasp pull failed: run "clasp login" and check the Script ID. & exit /b 1)
popd

echo 3/5  Copying Code into apps-script\Code.gs...
copy /Y "%PF_TMP%\Code.js" "apps-script\Code.gs" >nul || (echo Code.js was not found in the Apps Script project. & exit /b 1)
git diff --quiet -- apps-script/Code.gs && (echo Nothing changed: GitHub already has this code. & exit /b 0)

echo 4/5  Running the server tests...
call node tests\server-test.js apps-script\Code.gs >"%PF_TMP%\test.log" 2>&1
if errorlevel 1 (type "%PF_TMP%\test.log" & echo. & echo Tests FAILED: nothing was sent to GitHub. Fix the code, or undo with: git checkout -- apps-script/Code.gs & exit /b 1)

echo 5/5  Saving to GitHub...
set /p PF_MSG=Describe the change (one line): 
if "%PF_MSG%"=="" set "PF_MSG=Code.gs edited in the Apps Script editor"
git add apps-script/Code.gs
git commit -m "%PF_MSG%" || exit /b 1
git push || (echo git push failed. & exit /b 1)
echo.
echo Done. GitHub now has the editor's code (the automatic deploy publishes it again, same code).
endlocal
