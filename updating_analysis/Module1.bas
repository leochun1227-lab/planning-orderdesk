Attribute VB_Name = "Module1"
Sub CreateNewSheet()
    Dim wsSource As Worksheet
    Dim wsNew As Worksheet
    Dim wsSheet1 As Worksheet
    Dim newSheetName As String
    Dim todayDate As String
    Dim lastRow As Long
    Dim lastRowC As Long, lastRowF As Long, lastRowG As Long, lastRowH As Long
    Dim lastRowI As Long, lastRowJ As Long, lastRowK As Long, lastRowL As Long
    Dim lastRowM As Long, lastRowQ As Long, lastRowR As Long
    Dim cell As Range
    Dim i As Long
    Dim j As Long ' Separate variable for copying column Q to R
    Dim h As Long
    
    ' Turn off updates for speed
    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual

    ' Set the source worksheet (Sheet2)
    Set wsSource = ThisWorkbook.Sheets("Sheet2")
    ' Set the Sheet1 for text to columns operation
    Set wsSheet1 = ThisWorkbook.Sheets("Sheet1")

    ' Generate today's date
    todayDate = Format(Date, "mm-dd-yyyy")



    ' Create the new sheet with today's date in the name
    newSheetName = "Updating - " & todayDate
    On Error Resume Next ' Ignore error if sheet already exists
    Set wsNew = ThisWorkbook.Sheets(newSheetName)
    On Error GoTo 0
    If wsNew Is Nothing Then
        Set wsNew = ThisWorkbook.Sheets.Add(After:=ThisWorkbook.Sheets(ThisWorkbook.Sheets.Count))
        wsNew.Name = newSheetName
    End If

    ' Find the last row with data in each relevant column (C, F, G, H, I, J, K, L, M, Q, R)
    lastRowC = wsSource.Cells(wsSource.Rows.Count, "C").End(xlUp).Row
    lastRowF = wsSource.Cells(wsSource.Rows.Count, "F").End(xlUp).Row
    lastRowG = wsSource.Cells(wsSource.Rows.Count, "G").End(xlUp).Row
    lastRowH = wsSource.Cells(wsSource.Rows.Count, "H").End(xlUp).Row
    lastRowI = wsSource.Cells(wsSource.Rows.Count, "I").End(xlUp).Row
    lastRowJ = wsSource.Cells(wsSource.Rows.Count, "J").End(xlUp).Row
    lastRowK = wsSource.Cells(wsSource.Rows.Count, "K").End(xlUp).Row
    lastRowL = wsSource.Cells(wsSource.Rows.Count, "L").End(xlUp).Row
    lastRowM = wsSource.Cells(wsSource.Rows.Count, "M").End(xlUp).Row
    lastRowQ = wsSource.Cells(wsSource.Rows.Count, "Q").End(xlUp).Row
    lastRowR = wsSource.Cells(wsSource.Rows.Count, "R").End(xlUp).Row

    ' Determine the maximum last row across all relevant columns
    lastRow = Application.WorksheetFunction.Max(lastRowC, lastRowF, lastRowG, lastRowH, lastRowI, lastRowJ, lastRowK, lastRowL, lastRowM, lastRowQ, lastRowR)


' Perform Text to Columns on Sheet1's F column (assuming delimiter is space)
    wsSheet1.Range("F1:F" & lastRow).TextToColumns Destination:=wsSheet1.Range("F1"), DataType:=xlDelimited, _
        TextQualifier:=xlDoubleQuote, ConsecutiveDelimiter:=False, Tab:=True, Semicolon:=False, _
        Comma:=False, Space:=False, Other:=False


    ' Copy columns from Sheet2 to the new sheet
    wsNew.Range("A1:A" & lastRow).Value = wsSource.Range("C1:C" & lastRow).Value ' C to A
    
    wsNew.Range("D1:D" & lastRow).Value = wsSource.Range("G1:G" & lastRow).Value ' G to C
    wsNew.Range("H1:H" & lastRow).Value = wsSource.Range("K1:K" & lastRow).Value '
    wsNew.Range("I1:I" & lastRow).Value = wsSource.Range("F1:F" & lastRow).Value '
    wsNew.Range("J1:J" & lastRow).Value = wsSource.Range("L1:L" & lastRow).Value '
    wsNew.Range("K1:K" & lastRow).Value = wsSource.Range("J1:J" & lastRow).Value '
    wsNew.Range("L1:L" & lastRow).Value = wsSource.Range("M1:M" & lastRow).Value '
    

    ' Loop through rows and set values in columns L, M, N, and O if column K is not empty
    For i = 1 To lastRow
        If wsNew.Cells(i, "I").Value = "" Then
            Exit For ' Stop the loop if column K is empty
        End If
        
        ' Set values in columns L, M, N, and O
        wsNew.Cells(i, "M").Value = Date ' Set column L to today's date
        wsNew.Cells(i, "N").Value = Date ' Set column M to today's date
        wsNew.Cells(i, "O").Value = "No" ' Set column N to "No"
        wsNew.Cells(i, "P").Value = "No" ' Set column O to "No"
        wsNew.Cells(i, "Q").Value = "No" ' Set column O to "No"
    Next i

    ' Loop through rows and copy non-empty Q to R using a separate variable j
    For j = 1 To lastRow
        If wsSource.Cells(j, "S").Value <> "" Then
            wsNew.Cells(j, "R").Value = wsSource.Cells(j, "S").Value
        End If
    Next j
    
    ' Loop through rows and copy non-empty Q to R using a separate variable j
    For h = 1 To lastRow
        If wsSource.Cells(h, "P").Value <> "" Then
            wsNew.Cells(h, "U").Value = wsSource.Cells(h, "P").Value
        End If
    Next h

    ' Remove corner brackets and apply Text to Columns on Sheet1's F column
    lastRow = wsSheet1.Cells(wsSheet1.Rows.Count, "F").End(xlUp).Row

    ' Loop through the cells in column F to remove "<" and ">"
    For Each cell In wsSheet1.Range("F1:F" & lastRow)
        cell.Value = Replace(Replace(cell.Value, "<", ""), ">", "")
    Next cell

    ' Set Column A in the new sheet to the date format "dd/mm/yyyy"
    wsNew.Range("A1:A" & lastRow).NumberFormat = "dd/mm/yyyy"
    
    ' Restore Excel settings
    Application.ScreenUpdating = True
    Application.Calculation = xlCalculationAutomatic

    MsgBox "New sheet '" & newSheetName & "' has been created and formatted!"
End Sub


