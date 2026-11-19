# NRC ADAMS 문서 분석

미국 원자력규제위원회(NRC)의 공개 문서를 찾고 AI로 한영 요약과 맞춤 추출을 실행하는 로컬 웹앱입니다. 결과를 원문 인용과 함께 보관하고 CSV로 내보낼 수 있습니다.

[릴리즈 다운로드](https://github.com/sweetinsam-boop/nrc-adams-webapp/releases/latest) · [설치 및 사용 매뉴얼](MANUAL.md)

## Windows에서 시작하기

1. 릴리즈의 **Source code (zip)**을 내려받고 압축을 풉니다.
2. **Node.js 24 이상**을 설치합니다. PDF 미리보기와 긴 문서 분석을 사용하려면 Python 3도 설치하고 압축을 푼 폴더에서 아래 명령을 실행합니다.

   ```powershell
   py -3 -m pip install -r requirements.txt
   ```

3. `launch.cmd`를 더블클릭합니다. 브라우저가 자동으로 열리지 않으면 [로컬 앱](http://127.0.0.1:4317/)에 접속합니다.
4. 로그인 없이 바로 열립니다. **API 설정**에 Gemini, OpenAI 또는 Claude API 키를 등록합니다. NRC APS 키는 앱 안에서 검색 결과를 조회할 때 사용합니다. 키 없이도 NRC 공개 검색, ML 번호 조회, PDF 가져오기를 이용할 수 있습니다.
5. 검색창에 `ML24017A120`을 입력해 문서를 열고 **한영 요약 → 요약 생성**으로 실행을 확인합니다.

## macOS·Linux에서 시작하기

Node.js 24 이상과 Python 3을 설치한 뒤 압축을 푼 폴더에서 실행합니다. 브라우저가 자동으로 열립니다.

```bash
python3 -m pip install -r requirements.txt
node --env-file-if-exists=.env launcher.mjs
```

배포 파일은 소스 ZIP입니다. 보관함과 키는 첫 실행 후 로컬 데이터 폴더에 저장됩니다. 설정, 오류 대응 및 백업은 [사용 매뉴얼](MANUAL.md)을 참고하세요.

## 테스트

```powershell
npm.cmd test
```
