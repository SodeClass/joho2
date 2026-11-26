import cv2

img=cv2.imread('img.jpg',0)
temp=cv2.imread('temp.jpg',0)
cv2.imshow('img',img)
cv2.imshow('temp',temp)

sim=cv2.matchTemplate(img, temp, cv2.TM_CCOEFF_NORMED)
cv2.imshow('sim',sim)

min_val, max_val, min_loc, max_loc=cv2.minMaxLoc(sim)
print('類似度',max_val,'座標',max_loc)

top_left=max_loc
h,w=temp.shape
bottom_right=(top_left[0]+w,top_left[1]+h)

result=cv2.imread('img.jpg')
cv2.rectangle(result,top_left,bottom_right,(0,0,255),2)
cv2.imshow('result',result)
cv2.waitKey(0)
