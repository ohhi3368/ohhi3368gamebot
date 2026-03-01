# 오하이유흥봇

커스텀 주식 시스템이 포함된 Discord 봇입니다.
## 바이브 코딩임 버ㅏ그 있을수이슴

## 기능

- 어드민 대시보드(`http://localhost:3000` 기본)
  - 주식 추가(이름, 기본 주가, 기본 변동률)
  - 상장폐지/재상장
  - 통화 단위 변경(기본 `$`)
  - 시세 변경 주기 변경(기본 60초)
- 실시간 JSON 저장: `data/stock-data.json`
- 슬래시 명령어
  - 시세 확인: `/주식`, `/ㅈㅅ`, `/시세`, `/ㅅㅅ`
  - 매수: `/매수`, `/구매`, `/ㅁㅅ`, `/ㄱㅁ` (주식 자동완성)
  - 매도: `/매도`, `/판매`, `/ㅁㄷ`, `/ㅍㅁ` (보유 주식 자동완성)
  - 그래프: `/주식그래프` (PNG 이미지)
  - `/잔고`, `/배낭`
- 상장폐지 종목은 보유 목록에서 `[상장폐지된 주식]`으로 표시

## 필요한거
- PostgreSQL (없다면 `db-setup.sh` 실행하셈)
- NodeJS
- 컴퓨터의 뇌
- Linux (Windows면 WSL같은거 쓰세요)

## I. 실행 하려면 (권장)
1. 레포 훔치기 
```bash
git clone https://github.com/ohhi3368/ohhi3368gamebot.git
```
2. 패키지 설치
```bash
npm i
```
3. `bash db-setup.sh`로 DB 자동세팅
4. 실행하셈
```bash
npm start
```


## II. DB 없이 실행 하려면 (구)
### (JSON 파일로 데이터를 저장함)

1. `.env.templatehere` 참고해서 환경 변수 설정 하십쇼
2. DB 없이 실행하려면 `USE_JSON=true`로 변경
3. 실행하셈
```bash
npm start
```
개간단하죠이

## 기존 JSON 유저 데이터를 DB로 옮기려면
```bash
bash db-convert.sh
```

## 주의

- `CLIENT_ID`가 있어야 명령어 등록됨
- PostgreSQL 필요 (싫으면 II 참고)
- 대시보드는 `x-admin-token`으로 보호됩니다 `ADMIN_TOKEN` 반드시 변경하셈

# 라이선스
걍 가져다 쓰세요 개조를 해서 배포하든 상관없음 근ㄷ데 출처는 되도록 봇 설명이든 어디든 공개적인 곳에 남겨주샘 아래 카피해서
```
based on ohhi3368 (also d2tap)
```