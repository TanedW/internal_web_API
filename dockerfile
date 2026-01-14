# 1. ใช้ Node.js เวอร์ชั่นล่าสุด (หรือระบุเลขเวอร์ชั่นที่ใช้อยู่ เช่น node:18)
FROM node:18-alpine

# 2. กำหนดโฟลเดอร์ทำงานใน Docker
WORKDIR /app

# 3. ก๊อปปี้ไฟล์รายการ dependency ไปก่อน
COPY package*.json ./

# 4. ลงโปรแกรม/library ตามที่ระบุใน package.json
RUN npm install

# 5. ก๊อปปี้ไฟล์โปรเจกต์ทั้งหมด (รวม folder api, .dist ฯลฯ) เข้าไป
COPY . .

# 6. เปิด Port (เช็คในโค้ดว่าใช้พอร์ตอะไร แล้วเปลี่ยนเลขตรงนี้ให้ตรง)
EXPOSE 8080

# 7. คำสั่งรันโปรแกรม (ปกติจะดูจากใน scripts ของ package.json)
CMD ["npm", "start"]