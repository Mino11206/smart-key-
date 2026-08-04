#include <WiFi.h>
#include <WiFiClientSecure.h> 
#include <PubSubClient.h>
#include <SPI.h>
#include <MFRC522.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <RTClib.h>

// Đổi WiFiClient -> WiFiClientSecure
WiFiClientSecure net = WiFiClientSecure();
PubSubClient mqttClient(net);

RTC_DS3231 rtc; // Khởi tạo đối tượng RTC

const char* ssid = "Wokwi-GUEST";
const char* password = "";

// --- CẤU HÌNH AWS IOT CORE ---
const char* awsEndpoint = "a3pbjc0ct25cdw-ats.iot.ap-southeast-2.amazonaws.com"; 
const int awsPort = 8883; // Cổng MQTTS mặc định của AWS

// Root CA 1 của Amazon
const char AmazonRootCA1[] PROGMEM = R"KEY(
-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF
ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6
b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv
b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj
ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM
9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw
IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6
VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L
93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm
jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA
A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI
U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs
N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv
o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU
5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy
rqXRfboQnoZsG4q5WTP468SQvvG5
-----END CERTIFICATE------
)KEY";

// Device Certificate
const char DeviceCertificate[] PROGMEM = R"KEY(
-----BEGIN CERTIFICATE-----
MIIDWTCCAkGgAwIBAgIUc+Qih80h3AxjUPIzxV7mKxtP0H0wDQYJKoZIhvcNAQEL
BQAwTTFLMEkGA1UECwxCQW1hem9uIFdlYiBTZXJ2aWNlcyBPPUFtYXpvbi5jb20g
SW5jLiBMPVNlYXR0bGUgU1Q9V2FzaGluZ3RvbiBDPVVTMB4XDTI2MDgwMjA5NDA1
NVoXDTQ5MTIzMTIzNTk1OVowHjEcMBoGA1UEAwwTQVdTIElvVCBDZXJ0aWZpY2F0
ZTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAK64kBClxk7mNE/v/HiL
j+/29NlTS0IwdC6rs5VyPQDTEznm9VtixbvpsqFWB1t3OwONQ2po0gNpDbx5ILiD
Yiy0DraHqlmpRMfPb4siA/x3dXKIofpJIYMP5rSWCV4bqGKW70FL4lU8N+v5EIDw
egUT8wmLAFle8NW0bWW505izTvMg+iIKlD/zMUNa4Wm0N6M8rosCXGalCVi0bjmq
NGzynUahfoFoIKrAdLS4rJaqnFz53+xdJmdhfLdVB4imYZY+ey+Ncl8CX5y5SJz5
M0GNA8oj9u7RiOSlVFfCeaHZes2FbN3d7/zvc/q03s4cP8z8Ykwpb8cbpvGWcy+t
gMMCAwEAAaNgMF4wHwYDVR0jBBgwFoAUoTLfnVuSON/fUunmCMmfFQ+ULOEwHQYD
VR0OBBYEFKGmvyVVNiK2ANxnVo5iGUaQc6kWMAwGA1UdEwEB/wQCMAAwDgYDVR0P
AQH/BAQDAgeAMA0GCSqGSIb3DQEBCwUAA4IBAQCX4KQoGC0t4Ayw3BfA8Uv+ot24
5e08ddCcLbz0en3JsopbOReZCmW8ru/MHKNSmBt8z6CjuyVz0cyTOz0aIZD0b2f9
r7pVRF6vzjvyaHPGa/F9y7Tb0G6g4GeeBM84EBY/+mslpfw0et+9Jq9eYXQvTEYn
61W6IGFOCcGtRDp2exdQWC+CV+/QL+0qcLAeHSBBawuDxzJ3KzrhjmIZd2nQO+om
V87UHxZgSNma2D0ECrsMEVF83nzUqItlMPdFDtpzQ1/syWNLEjcicdmC4g93h48e
EdOUpMfW9nsehjiURkLVAig/vP4HOFl2OBx9UjUOwB2ob8P08Ne31bj1IE7U
-----END CERTIFICATE-----

)KEY";

// Private Key
const char PrivateKey[] PROGMEM = R"KEY(
-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEArriQEKXGTuY0T+/8eIuP7/b02VNLQjB0LquzlXI9ANMTOeb1
W2LFu+myoVYHW3c7A41DamjSA2kNvHkguINiLLQOtoeqWalEx89viyID/Hd1coih
+kkhgw/mtJYJXhuoYpbvQUviVTw36/kQgPB6BRPzCYsAWV7w1bRtZbnTmLNO8yD6
IgqUP/MxQ1rhabQ3ozyuiwJcZqUJWLRuOao0bPKdRqF+gWggqsB0tLislqqcXPnf
7F0mZ2F8t1UHiKZhlj57L41yXwJfnLlInPkzQY0DyiP27tGI5KVUV8J5odl6zYVs
3d3v/O9z+rTezhw/zPxiTClvxxum8ZZzL62AwwIDAQABAoIBAHRQf+/lPGCYFilF
PZFOb7Mzd4saTVayBRZwzevmkj/zRLBeVebRmYtgp7+KEvnMJShXKZM0VuNYU4Gu
LZ9IL9pMwCK5rClma1iNetdn/LldGX33AcYqWznyIwcDfxb8WJvRmVOh3foaTaw1
Mcx0yvaIclpfBAt7Dd9m7xEypW/YjTaQ8iuu7KjO/F9OOFwOJ9cCrMMySKyZ+Elz
i+9AO6wEimH2LJp7+SJqH1s86GsuuCxbzxWiCpIZ8Nup30X991IO3Wk40mw4hjv+
DtnZzfEzfDH2txAavYIQs4Pt0UkwHLo+ha+pDUdrgy+kYjuLr0VKvvb+DUbkbyE3
FOPdMLECgYEA2d5qoL1lnPoCc5H4AHiuhCHyeJzMtPS24lZNZ22xgfC/HlLln5b6
ZidB38Ew6gP8Rj/8dX0/AkCB4p/WpSwDRognnMbh4HWu7BoWZCVvmFP0XH3X4pn8
ww+FfyQnBalAeJocNbAVUlz/r906v2IICbXHLRVuQtdK6ZNfeGjJPBkCgYEAzUzp
ar136vtmVunP4NQRd2nT9gtRmjzUf+hkYMLIIAzp90h1pjHyNHP5Fo9SJ7gXpaGa
3CiL9AZFDc9mPTtsvvHFW8DUk0K/1338xi269BHMF8pFO1EwQHe6RaJJcgRiK4NN
tVgYzDANpwE6D3ZrEkBLBzaAkVsu9+HiPP/mvzsCgYEA1oVsFE2pCgIZ+9XUjhJG
NBCBAUXTQrJaiU5U9OxLhhiY9rDFLHiqoX8yG7HMCgBWnI1QdhcWvY7q1UxxOz21
E/PonTQvIKZ/0DZ3qbA6y5CO4at/sL3S5fYYinH8glR/CMEl2a9Br1Gm6XE58UwD
ghwcvEWHxgTa3FaiAJuc2bECgYEAzJ7j5ueBJkv77JSOBOBZqFNqV8lgRAJtKi9O
HMMHBCra5wTpfgQ6C92rXrjqgXwS1ZsE5nnjRA0btnAIzu7zrDz9ID5JoZzd6MJB
tqTNuYYjjXKlHkIFfbvXhKAD5AhKcGQmh6CO1rTuZo3qeI7mmQJLxZyk+DuRzK7u
9y13pxECgYEAv/3whrTjFBIS+Chs5kshnyl4kMJQAkcO7xWCZ2NY1mZcVe29/7n2
4kgT8eel9vDDdpWX+6RnIsUdF/kr3bngQkzeskuWorKPaKeEvMs4aAs+Cvk/dFFz
DwDEPKvK79fmG0a0mGxWfsr5wF3eAdv+Ah6li7T43o/hJQXDYrqhMYQ=
-----END RSA PRIVATE KEY-----

)KEY";





// RFID: Định nghĩa chân kết nối với ESP32
#define RST_PIN  17
#define SS_PIN   23   

// RFID: Khởi tạo đối tượng MFRC522
MFRC522 rfid(SS_PIN, RST_PIN); 

//RFID: Định nghĩa UID của một thẻ hợp lệ được phép ra vào (thẻ màu xanh dương mặc định)
String authorizedUID = "01 02 03 04"; 


// Cấu hình múi giờ Việt Nam (GMT+7, không đổi giờ mùa hè)
const char* ntpServer = "pool.ntp.org";
const long gmtOffset_sec = 7 * 3600;       // 7 tiếng = 25200 giây
const int daylightOffset_sec = 0;

void wifiConnect() {
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(" Connected!");
}

void mqttConnect() {
  while(!mqttClient.connected()) {
    Serial.println("Attemping MQTT connection...");
    String clientId = "ESP32Client-" + String(random(0xffff), HEX);
    if(mqttClient.connect(clientId.c_str())) {
      Serial.println("connected");

      //***Subscribe all topic you need***
      mqttClient.subscribe("MSSV/led");
     
    }
    else {
      Serial.print(mqttClient.state());
      Serial.println("try again in 5 seconds");
      delay(5000);
    }
  }
}

//MQTT Receiver
void callback(char* topic, byte* message, unsigned int length) {
  Serial.println(topic);
  String msg;
  for(int i=0; i<length; i++) {
    msg += (char)message[i];
  }
  Serial.println(msg);

  //***Code here to process the received package***

}

String getFormattedTimestamp() {
    DateTime now = rtc.now(); // Đọc trực tiếp từ phần cứng RTC lập tức
    
    char buffer[25];
    sprintf(buffer, "%04d-%02d-%02d %02d:%02d:%02d", 
            now.year(), now.month(), now.day(), 
            now.hour(), now.minute(), now.second());
            
    return String(buffer);
}



void setup() {
  Serial.begin(9600);
  Serial.print("Connecting to WiFi");

  wifiConnect();

  // Cấu hình chứng chỉ TLS cho WiFiClientSecure
  net.setCACert(AmazonRootCA1);
  net.setCertificate(DeviceCertificate);
  net.setPrivateKey(PrivateKey);

  // Kết nối đến AWS MQTT Endpoint
  mqttClient.setServer(awsEndpoint, awsPort);
  mqttClient.setCallback(callback);
  
  // RFID
  SPI.begin(22, 19, 21, 23);  // Khởi tạo giao tiếp SPI
  rfid.PCD_Init();   // Khởi tạo module MFRC522
  Serial.println("Vui lòng quẹt thẻ...");
  
  // Khai báo chân SDA (35) và SCL (32) tùy chỉnh cho ESP32 trước
  Wire.begin(14, 32);

  // Khởi động RTC với cổng Wire vừa cấu hình
  if (!rtc.begin(&Wire)) {
    Serial.println("Không tìm thấy module RTC!");
  } else {
    Serial.println("Đã kết nối RTC thành công!");
  }
}


void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.print("Reconnecting to WiFi");
    wifiConnect();
  }
  if(!mqttClient.connected()) {
    mqttConnect();
  }
  mqttClient.loop();


  // ============== KHỐI LỆNH ĐỌC THẺ =======================
  // 1. Kiểm tra xem có thẻ mới đưa vào gần đầu đọc không
  if (!rfid.PICC_IsNewCardPresent()) {
    return;
  }

  // 2. Đọc serial (UID) của thẻ
  if (!rfid.PICC_ReadCardSerial()) {
    return;
  }

  // 3. Chuyển đổi UID đọc được thành dạng chuỗi (String) để dễ so sánh
  String currentUID = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    currentUID += (rfid.uid.uidByte[i] < 0x10 ? " 0" : " ");
    currentUID += String(rfid.uid.uidByte[i], HEX);
  }
  currentUID.trim(); // Xóa khoảng trắng thừa ở đầu
  currentUID.toUpperCase(); // Chuyển về chữ hoa cho đồng bộ

  Serial.print("Mã UID của thẻ vừa quẹt: ");
  Serial.println(currentUID);

  // 4. So sánh thẻ có hợp lệ hay không (Logic ra vào)
  if (currentUID == "01:02:03:04" || currentUID == "01 02 03 04") { // Tùy thuộc định dạng in
    Serial.println("--> Xin chào Alice! ĐÃ XÁC THỰC: Mở cửA.");
    
  } else {
    Serial.println("--> CẢNH BÁO: Thẻ không hợp lệ! Từ chối truy cập.");
  }

  // Dừng đọc thẻ hiện tại để tránh đọc lặp liên tục
  rfid.PICC_HaltA();
  //***Publish data to MQTT Server***
  String accessTime = getFormattedTimestamp();

    // Tạo đối tượng JSON
    StaticJsonDocument<200> jsonDoc;
    jsonDoc["uid"] = currentUID;
    jsonDoc["access_time"] = accessTime; 

    // Chuyển sang chuỗi JSON và Publish MQTT
    char jsonBuffer[256];
    serializeJson(jsonDoc, jsonBuffer);
    mqttClient.publish("MSSV/access_log", jsonBuffer);

  delay(1000); // Chờ 1 giây cho lần quẹt tiếp theo

}


