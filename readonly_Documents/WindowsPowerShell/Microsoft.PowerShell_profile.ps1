
function cc { Set-Location 'G:\我的雲端硬碟\I_Claude_date'; $env:CLAUDE_CODE_NO_FLICKER=1; claude @args }


function stock { $env:PYTHONIOENCODING='utf-8'; python 'G:\我的雲端硬碟\I_Claude_date\taiwan_stock_predictor\predictor.py' $args }
